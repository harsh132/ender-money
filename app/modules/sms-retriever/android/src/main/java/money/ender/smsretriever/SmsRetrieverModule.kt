package money.ender.smsretriever

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android's SMS Retriever: Play services hands the app the next SMS that ends with the app's hash, no permission
 * needed. One message per start(), within five minutes. Messages are kept here until drain(), so a reply that lands
 * while the app is in the background (the user still in the SMS app) is handed over when it comes back; "onSms" only
 * says there is something to drain. (RECEIVE_SMS was dropped: Play Protect blocks sideloaded apps that ask for it.)
 */
class SmsRetrieverModule : Module() {
  private var receiver: BroadcastReceiver? = null
  private val pending = mutableListOf<String>()
  private val context get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("SmsRetriever")
    Events("onSms")

    AsyncFunction("start") {
      stop()
      val r = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
          if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
          val extras = intent.extras ?: return
          @Suppress("DEPRECATION")
          val status = extras.get(SmsRetriever.EXTRA_STATUS) as? Status ?: return
          if (status.statusCode == CommonStatusCodes.SUCCESS) {
            val message = extras.getString(SmsRetriever.EXTRA_SMS_MESSAGE) ?: return
            synchronized(pending) { pending.add(message) }
            sendEvent("onSms", mapOf<String, Any>())
          }
        }
      }
      val filter = IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION)
      // Exported: Play services sends it, guarded by SEND_PERMISSION.
      if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(r, filter, SmsRetriever.SEND_PERMISSION, null, Context.RECEIVER_EXPORTED)
      else context.registerReceiver(r, filter, SmsRetriever.SEND_PERMISSION, null)
      receiver = r
      SmsRetriever.getClient(context).startSmsRetriever()
      Unit
    }

    AsyncFunction("drain") { synchronized(pending) { pending.toList().also { pending.clear() } } }

    Function("stop") { stop() }

    OnDestroy { stop() }
  }

  private fun stop() {
    receiver?.let { runCatching { context.unregisterReceiver(it) } }
    receiver = null
  }
}
