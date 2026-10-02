package money.ender.relay

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.telephony.SmsManager
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Keeps one WebSocket open to the gateway's /relay endpoint.
 *
 *   inbound SMS  -> { type: inbound, id, from, body, receivedAt }, kept until the gateway acks it
 *   { type: send, id, to, body } -> SmsManager, then { type: sent, id, ok, error? }
 *
 * ponytail: unacked inbound texts live in memory; if Android kills the service
 * they're lost (they're still in the phone's inbox). Persist them if that ever bites.
 */
class RelayService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient()
    private var socket: WebSocket? = null
    private var backoffMs = 1_000L
    private var stopped = false
    /** Inbound texts not yet acked by the gateway, resent on every reconnect. */
    private val unacked = ConcurrentHashMap<String, JSONObject>()

    private val sentReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val id = intent.getStringExtra(EXTRA_ID) ?: return
            val ok = resultCode == Activity.RESULT_OK
            log(if (ok) "sent $id" else "send failed $id (code $resultCode)")
            socket?.send(JSONObject().put("type", "sent").put("id", id).put("ok", ok).apply { if (!ok) put("error", "code $resultCode") }.toString())
        }
    }

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(sentReceiver, IntentFilter(ACTION_SENT), RECEIVER_NOT_EXPORTED)
        else registerReceiver(sentReceiver, IntentFilter(ACTION_SENT))
        val channel = NotificationChannel(CHANNEL, "Relay", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, notification("Connecting"), ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else startForeground(1, notification("Connecting"))
        connect()
        main.postDelayed(object : Runnable {
            override fun run() {
                socket?.send("ping")
                main.postDelayed(this, 30_000)
            }
        }, 30_000)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val from = intent?.getStringExtra(EXTRA_FROM)
        val body = intent?.getStringExtra(EXTRA_BODY)
        if (from != null && body != null) {
            val msg = JSONObject().put("type", "inbound").put("id", UUID.randomUUID().toString())
                .put("from", from).put("body", body).put("receivedAt", System.currentTimeMillis())
            unacked[msg.getString("id")] = msg
            log("in  $from: ${body.take(40)}")
            socket?.send(msg.toString())
        }
        return START_STICKY
    }

    private fun connect() {
        val prefs = Prefs(this)
        if (prefs.url.isBlank() || prefs.token.isBlank()) return log("set the gateway URL and token first")
        val request = Request.Builder().url(prefs.url).header("Authorization", "Bearer ${prefs.token}").build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                backoffMs = 1_000L
                log("connected")
                update("Connected")
                unacked.values.forEach { webSocket.send(it.toString()) }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text == "pong") return
                val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (msg.optString("type")) {
                    "ack" -> unacked.remove(msg.optString("id"))
                    "send" -> sendSms(msg.getString("id"), msg.getString("to"), msg.getString("body"))
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = retry("closed: $reason")
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = retry("failed: ${t.message}")
        })
    }

    private fun retry(why: String) {
        socket = null
        if (stopped) return
        log("$why, retrying in ${backoffMs / 1000}s")
        update("Reconnecting")
        main.postDelayed({ connect() }, backoffMs)
        backoffMs = (backoffMs * 2).coerceAtMost(60_000L)
    }

    private fun sendSms(id: String, to: String, body: String) {
        log("out $to: ${body.take(40)}")
        @Suppress("DEPRECATION")
        val sms = if (Build.VERSION.SDK_INT >= 31) getSystemService(SmsManager::class.java) else SmsManager.getDefault()
        val sent = PendingIntent.getBroadcast(
            this, id.hashCode(),
            Intent(ACTION_SENT).setPackage(packageName).putExtra(EXTRA_ID, id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val parts = sms.divideMessage(body)
        if (parts.size == 1) sms.sendTextMessage(to, null, body, sent, null)
        else sms.sendMultipartTextMessage(to, null, parts, ArrayList(parts.map { sent }), null)
    }

    private fun notification(text: String): Notification =
        Notification.Builder(this, CHANNEL).setContentTitle("Ender Relay").setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_chat).setOngoing(true).build()

    private fun update(text: String) = getSystemService(NotificationManager::class.java).notify(1, notification(text))

    override fun onDestroy() {
        stopped = true
        main.removeCallbacksAndMessages(null)
        socket?.close(1000, "service stopped")
        unregisterReceiver(sentReceiver)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL = "relay"
        private const val ACTION_SENT = "money.ender.relay.SENT"
        private const val EXTRA_ID = "id"
        private const val EXTRA_FROM = "from"
        private const val EXTRA_BODY = "body"

        /** Recent lines for the settings screen. */
        val logLines = ArrayDeque<String>()

        fun log(line: String) = synchronized(logLines) {
            logLines.addFirst("${SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())}  $line")
            while (logLines.size > 100) logLines.removeLast()
        }

        fun start(context: Context) = context.startForegroundService(Intent(context, RelayService::class.java))

        fun forward(context: Context, from: String, body: String) =
            context.startForegroundService(Intent(context, RelayService::class.java).putExtra(EXTRA_FROM, from).putExtra(EXTRA_BODY, body))
    }
}

class Prefs(context: Context) {
    private val p = context.getSharedPreferences("relay", Context.MODE_PRIVATE)
    var url: String
        get() = p.getString("url", "wss://api.ender.money/relay")!!
        set(v) = p.edit().putString("url", v).apply()
    var token: String
        get() = p.getString("token", "")!!
        set(v) = p.edit().putString("token", v).apply()
}
