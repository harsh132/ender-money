// Groth16 prover for Ender's split-key shielded pool: circom's C++ witness generators + rapidsnark behind one HTTP port.
//   GET  /health                     200 {"loaded":[2,...],"maxrssMiB":..,"cgroupPeakMiB":..}; listening only starts once the 2-in key is loaded
//   GET  /warm?circuit=6             loads that key now (the 2-in is always loaded), then answers like /health
//   POST /prove {"circuit":N,"input":{...}}  200 {"proof":{pi_a,pi_b,pi_c,protocol,curve},"publicSignals":[...]} (snarkjs fullProve shape)
// Errors: {"error":"..."} with 400 (bad request), 422 (witness rejected: constraint not satisfied, missing/extra signal), 500.
// Request bodies hold the user's nullifier key: they are never logged and never touch disk (witness goes through pipes).
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <fstream>
#include <mutex>
#include <stdexcept>
#include <string>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "prover.h"

using json = nlohmann::json;
extern char **environ;

static const int CIRCUITS[] = {2, 6, 12};
static std::atomic<void *> provers[3];
static std::once_flag loaded[3];
static std::mutex prove_mu;  // ponytail: one proof at a time (sized for 1 vCPU); per-circuit locks if instances get more cores
static const std::string DIR = getenv("PROVER_DIR") ? getenv("PROVER_DIR") : "/app";

struct HttpError : std::runtime_error {
  int status;
  HttpError(int s, const std::string &m) : std::runtime_error(m), status(s) {}
};

static long ms_since(std::chrono::steady_clock::time_point t) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t).count();
}

static int index_of(int n) { return n == 2 ? 0 : n == 6 ? 1 : n == 12 ? 2 : -1; }

static void load(int i) {
  auto t = std::chrono::steady_clock::now();
  std::string path = DIR + "/keys/transaction" + std::to_string(CIRCUITS[i]) + ".zkey";
  // The prover keeps pointers into this buffer, so it lives as long as the process. (rapidsnark v0.0.8's
  // groth16_prover_create_zkey_file unmaps the file on return and leaves the prover dangling: don't use it.)
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) throw std::runtime_error("load key: cannot open " + path);
  auto *zkey = new std::string(f.tellg(), '\0');
  f.seekg(0).read(zkey->data(), zkey->size());
  void *p = nullptr;
  char err[256] = "";
  if (!f || groth16_prover_create(&p, zkey->data(), zkey->size(), err, sizeof err) != PROVER_OK) throw std::runtime_error(std::string("load key: ") + err);
  provers[i] = p;
  fprintf(stderr, "loaded transaction%d.zkey in %ld ms\n", CIRCUITS[i], ms_since(t));
}

// Lazy, once per circuit; a failed load throws and is retried on the next call.
static void *prover(int i) {
  std::call_once(loaded[i], load, i);
  return provers[i];
}

// Every leaf must be a non-negative integer or a decimal/0x-hex string. JSON numbers become strings (circom reads numbers as
// doubles, which would silently lose precision above 2^53). Errors name the signal, never the value.
static void clean(json &v, const std::string &path) {
  if (v.is_object()) {
    for (auto &[k, x] : v.items()) clean(x, path.empty() ? k : path + "." + k);
  } else if (v.is_array()) {
    for (size_t i = 0; i < v.size(); i++) clean(v[i], path + "[" + std::to_string(i) + "]");
  } else if (v.is_number_unsigned()) {
    v = std::to_string(v.get<uint64_t>());
  } else if (v.is_string()) {
    const std::string &s = v.get_ref<const std::string &>();
    bool hex = s.size() > 2 && (s.rfind("0x", 0) == 0 || s.rfind("0X", 0) == 0);
    size_t from = hex ? 2 : 0;
    if (s.size() == from || s.size() > 80) throw HttpError(400, "input." + path + ": not a field element");
    for (size_t j = from; j < s.size(); j++)
      if (!(isdigit((unsigned char)s[j]) || (hex && isxdigit((unsigned char)s[j])))) throw HttpError(400, "input." + path + ": not a field element");
  } else {
    throw HttpError(400, "input." + path + ": must be a decimal string or a non-negative integer");
  }
}

// Runs build/transactionN with the input JSON on stdin; the .wtns comes back on stdout. The child reads all of stdin before
// writing anything, so writing everything then reading everything can't deadlock. stderr is merged into stdout: on failure
// it holds circom's message ("Failed assert in template ... line N", "Error loading signal ...").
static std::string witness(int n, const std::string &input) {
  std::string bin = DIR + "/witness/transaction" + std::to_string(n);
  int in[2], out[2];
  if (pipe2(in, O_CLOEXEC) || pipe2(out, O_CLOEXEC)) throw std::runtime_error("pipe");
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, in[0], 0);
  posix_spawn_file_actions_adddup2(&fa, out[1], 1);
  posix_spawn_file_actions_adddup2(&fa, out[1], 2);
  char *argv[] = {bin.data(), (char *)"/dev/stdin", (char *)"/dev/stdout", nullptr};
  pid_t pid;
  int rc = posix_spawn(&pid, bin.c_str(), &fa, nullptr, argv, environ);
  posix_spawn_file_actions_destroy(&fa);
  close(in[0]);
  close(out[1]);
  if (rc) {
    close(in[1]);
    close(out[0]);
    throw std::runtime_error("spawn witness generator");
  }
  for (size_t off = 0; off < input.size();) {
    ssize_t w = write(in[1], input.data() + off, input.size() - off);
    if (w <= 0) break;  // child died early; its exit status says why
    off += w;
  }
  close(in[1]);
  std::string wtns;
  char buf[1 << 16];
  for (ssize_t r; (r = read(out[0], buf, sizeof buf)) > 0;) wtns.append(buf, r);
  close(out[0]);
  int status = 0;
  waitpid(pid, &status, 0);
  if (WIFEXITED(status) && WEXITSTATUS(status) == 0 && wtns.rfind("wtns", 0) == 0) return wtns;
  size_t what = wtns.find("what():  ");  // an uncaught exception: its message follows "terminate called ..."
  if (what != std::string::npos) wtns.erase(0, what + 9);
  std::string msg = wtns.substr(0, wtns.find('\n')).substr(0, 300);
  throw HttpError(422, "witness: " + (msg.empty() ? "generator failed" : msg));
}

static json prove(const json &req) {
  if (!req.is_object() || !req.contains("circuit") || !req["circuit"].is_number_integer()) throw HttpError(400, "circuit: 2, 6 or 12");
  int n = req["circuit"].get<int>(), i = index_of(n);
  if (i < 0) throw HttpError(400, "circuit: 2, 6 or 12");
  if (!req.contains("input") || !req["input"].is_object()) throw HttpError(400, "input: object expected");
  json input = req["input"];
  clean(input, "");

  std::lock_guard<std::mutex> lock(prove_mu);
  void *p = prover(i);
  auto t = std::chrono::steady_clock::now();
  std::string wtns = witness(n, input.dump());
  long tw = ms_since(t);
  char proof[4096], pub[4096], err[256] = "";
  unsigned long long proof_size = sizeof proof, pub_size = sizeof pub;
  t = std::chrono::steady_clock::now();
  int rc = groth16_prover_prove(p, wtns.data(), wtns.size(), proof, &proof_size, pub, &pub_size, err, sizeof err);
  if (rc != PROVER_OK) throw HttpError(rc == PROVER_INVALID_WITNESS_LENGTH ? 422 : 500, std::string("prove: ") + err);
  fprintf(stderr, "prove n=%d witness=%ld ms groth16=%ld ms\n", n, tw, ms_since(t));
  json pj = json::parse(proof, proof + proof_size);
  pj["curve"] = "bn128";  // rapidsnark omits it; snarkjs fullProve includes it
  return {{"proof", pj}, {"publicSignals", json::parse(pub, pub + pub_size)}};
}

static json status() {
  json l = json::array();
  for (int i = 0; i < 3; i++)
    if (provers[i]) l.push_back(CIRCUITS[i]);
  rusage self{};
  getrusage(RUSAGE_SELF, &self);
  long long peak = -1;  // whole container incl. witness children and page cache (cgroup v2), when visible
  std::ifstream("/sys/fs/cgroup/memory.peak") >> peak;
  return {{"loaded", l}, {"maxrssMiB", self.ru_maxrss / 1024}, {"cgroupPeakMiB", peak < 0 ? json() : json(peak >> 20)}};
}

static void reply(httplib::Response &res, int code, const json &body) {
  res.status = code;
  res.set_content(body.dump(), "application/json");
}

int main() {
  signal(SIGPIPE, SIG_IGN);
  // As PID 1 the kernel drops SIGTERM unless we handle it, and SIGTERM is how sleepAfter stops the container: without
  // this the prover never sleeps and bills 3 GiB around the clock. Stateless, so exiting on the spot is safe.
  signal(SIGTERM, [](int) { _exit(0); });
  prover(0);  // the 2-in key is loaded before the port opens, so "port open" (what Cloudflare waits for) means ready
  httplib::Server srv;
  srv.set_payload_max_length(1 << 20);
  srv.Get("/health", [](const httplib::Request &, httplib::Response &res) { reply(res, 200, status()); });
  srv.Get("/warm", [](const httplib::Request &req, httplib::Response &res) {
    int i = index_of(atoi(req.get_param_value("circuit").c_str()));
    if (i < 0) return reply(res, 400, {{"error", "circuit: 2, 6 or 12"}});
    try {
      prover(i);
      reply(res, 200, status());
    } catch (const std::exception &e) {
      reply(res, 500, {{"error", e.what()}});
    }
  });
  srv.Post("/prove", [](const httplib::Request &req, httplib::Response &res) {
    try {
      reply(res, 200, prove(json::parse(req.body)));
    } catch (const HttpError &e) {
      fprintf(stderr, "prove failed: %d\n", e.status);  // status only: the message may name signals of a user's input
      reply(res, e.status, {{"error", e.what()}});
    } catch (const json::exception &) {
      reply(res, 400, {{"error", "body: invalid JSON"}});
    } catch (const std::exception &e) {
      fprintf(stderr, "prove failed: 500\n");
      reply(res, 500, {{"error", e.what()}});
    }
  });
  int port = getenv("PORT") ? atoi(getenv("PORT")) : 8080;
  fprintf(stderr, "listening on :%d\n", port);
  return srv.listen("0.0.0.0", port) ? 0 : 1;
}
