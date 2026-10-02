package money.ender.relay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/** Every incoming SMS goes to the gateway. Multipart texts arrive as several PDUs; join them per sender. */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        parts.groupBy { it.originatingAddress.orEmpty() }.forEach { (from, pdus) ->
            if (from.isNotEmpty()) RelayService.forward(context, from, pdus.joinToString("") { it.messageBody.orEmpty() })
        }
    }
}
