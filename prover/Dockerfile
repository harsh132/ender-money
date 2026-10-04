# Groth16 prover for the split-key pool. Run ./sync.sh first (copies circuits, circomlib and the existing zkeys into assets/).
# Build: docker build -t ender-prover .     Run: docker run --rm -p 8080:8080 ender-prover
FROM debian:bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake nasm libgmp-dev git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src

# rapidsnark (iden3), static library with its own Fr/Fq asm
RUN git clone -q --depth 1 --branch v0.0.8 https://github.com/iden3/rapidsnark \
 && cd rapidsnark && git submodule -q update --init --depth 1 depends/ffiasm depends/json \
 && cmake -S . -B b -DCMAKE_BUILD_TYPE=Release >/dev/null \
 && cmake --build b --target rapidsnarkStaticFrFq -j"$(nproc)" >/dev/null
RUN curl -fsSLo /usr/local/bin/circom https://github.com/iden3/circom/releases/download/v2.2.3/circom-linux-amd64 \
 && echo "85342c7ff332d948df7c0c50ecf201e6129349aef550ce873f3c811b79fe53a3  /usr/local/bin/circom" | sha256sum -c - \
 && chmod +x /usr/local/bin/circom \
 && curl -fsSLo httplib.h https://raw.githubusercontent.com/yhirose/cpp-httplib/v0.59.0/httplib.h \
 && echo "dc1e4de3e0ef3a18f3a5818fab563eb3fa45d5d3bb1db527a8d389077ed5ee6c  httplib.h" | sha256sum -c -

# circom's C++ witness generators, one static binary + .dat per circuit. The compile must reproduce the spike's .r1cs
# byte for byte (same circom 2.2.3, --O2), so the witnesses match the baked zkeys.
COPY assets/circuits circuits
COPY assets/lib lib
COPY assets/keys/*.r1cs ref/
RUN mkdir out && for n in 2 6 12; do \
      circom circuits/transaction$n.circom --O2 --c --r1cs -l lib -o out >/dev/null \
      && cmp out/transaction$n.r1cs ref/transaction$n.r1cs \
      && make -s -C out/transaction${n}_cpp -j"$(nproc)" CC="g++ -static -s -I/src/rapidsnark/depends/json/single_include" \
      && mkdir -p /app/witness && cp out/transaction${n}_cpp/transaction$n out/transaction${n}_cpp/transaction$n.dat /app/witness/ \
      || exit 1; done

COPY server.cpp .
RUN g++ -O2 -std=c++17 -static -s -fopenmp server.cpp -I. -Irapidsnark/src -Irapidsnark/depends/json/single_include \
      rapidsnark/b/src/librapidsnark-fr-fq.a -lgmp -lpthread -o /app/prover

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /app /app
COPY assets/keys/*.zkey /app/keys/
EXPOSE 8080
ENTRYPOINT ["/app/prover"]
