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
 * Two ways in. With RECEIVE_SMS: SmsReceiver queues texts from the gateway's numbers (setSenders), even while the
 * app is closed; drain() hands them over and "onInbox" says there are new ones. Without it, Android's SMS Retriever:
 * Play services hands the app the next SMS that ends with the app's hash, no permission needed. One message per
 * start(), within five minutes ("onSms").
 */
class SmsRetrieverModule : Module() {
  private var receiver: BroadcastReceiver? = null
  private val context get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("SmsRetriever")
    Events("onSms", "onInbox")

    OnCreate { SmsInbox.onAdded = { sendEvent("onInbox", mapOf<String, Any>()) } }

    Function("setSenders") { numbers: List<String> -> SmsInbox.setSenders(context, numbers) }

    AsyncFunction("drain") { SmsInbox.drain(context) }

    AsyncFunction("start") {
      stop()
      val r = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
          if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
          val extras = intent.extras ?: return
          @Suppress("DEPRECATION")
          val status = extras.get(SmsRetriever.EXTRA_STATUS) as? Status ?: return
          if (status.statusCode == CommonStatusCodes.SUCCESS) {
            sendEvent("onSms", mapOf("message" to extras.getString(SmsRetriever.EXTRA_SMS_MESSAGE)))
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

    Function("stop") { stop() }

    OnDestroy {
      stop()
      SmsInbox.onAdded = null
    }
  }

  private fun stop() {
    receiver?.let { runCatching { context.unregisterReceiver(it) } }
    receiver = null
  }
}
