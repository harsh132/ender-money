package money.ender.smsretriever

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONObject

/**
 * Texts from the gateway's numbers (RECEIVE_SMS), kept in a small queue in SharedPreferences until JS drains it,
 * so they survive the app being closed. Any other sender is dropped before its body is read, and nothing is logged.
 */
object SmsInbox {
  private const val PREFS = "ender.sms"
  private const val MAX = 50

  /** Set while the JS runtime is up: tells it to drain. */
  @Volatile var onAdded: (() -> Unit)? = null

  private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** Last ten digits: carriers report the same number as +91…, 91…, 0… or bare. */
  private fun tail(n: String) = n.filter(Char::isDigit).takeLast(10)

  @Synchronized fun setSenders(c: Context, numbers: List<String>) {
    prefs(c).edit().putStringSet("senders", numbers.map(::tail).filter { it.length == 10 }.toSet()).commit()
  }

  fun allowed(c: Context, from: String): Boolean {
    val t = tail(from)
    return t.length == 10 && prefs(c).getStringSet("senders", emptySet())!!.contains(t)
  }

  private fun read(c: Context) = JSONArray(prefs(c).getString("queue", null) ?: "[]")

  /** Deduped by body + timestamp; the oldest go first past MAX. */
  @Synchronized fun add(c: Context, from: String, body: String, at: Long) {
    val q = read(c)
    for (i in 0 until q.length()) {
      val o = q.getJSONObject(i)
      if (o.getString("body") == body && o.getLong("at") == at) return
    }
    q.put(JSONObject().put("from", from).put("body", body).put("at", at))
    while (q.length() > MAX) q.remove(0)
    prefs(c).edit().putString("queue", q.toString()).commit()
    onAdded?.invoke()
  }

  @Synchronized fun drain(c: Context): List<Map<String, Any>> {
    val q = read(c)
    prefs(c).edit().remove("queue").commit()
    return (0 until q.length()).map {
      val o = q.getJSONObject(it)
      mapOf("from" to o.getString("from"), "body" to o.getString("body"), "at" to o.getLong("at").toDouble())
    }
  }
}

/** SMS_RECEIVED: the platform hands over all parts of one message together; joined in order. */
class SmsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
    val first = parts.firstOrNull() ?: return
    val from = first.originatingAddress ?: return
    if (!SmsInbox.allowed(context, from)) return
    SmsInbox.add(context, from, parts.joinToString("") { it.messageBody ?: "" }, first.timestampMillis)
  }
}
