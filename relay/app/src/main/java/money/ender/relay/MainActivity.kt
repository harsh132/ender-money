package money.ender.relay

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** Pairing and a log. Nothing else: the phone sits plugged in and runs RelayService. */
class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var log: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        val url = EditText(this).apply { hint = "wss://api.ender.money/relay"; setText(prefs.url); isSingleLine = true }
        val token = EditText(this).apply {
            hint = "Relay token"; setText(prefs.token); isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val start = Button(this).apply {
            text = "Save and start relay"
            setOnClickListener {
                prefs.url = url.text.toString().trim()
                prefs.token = token.text.toString().trim()
                stopService(Intent(this@MainActivity, RelayService::class.java))
                RelayService.start(this@MainActivity)
            }
        }
        val battery = Button(this).apply {
            text = "Allow running in background"
            setOnClickListener {
                if (!getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName))
                    startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            }
        }
        log = TextView(this).apply { textSize = 12f; setTextIsSelectable(true) }
        setContentView(ScrollView(this).apply {
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(32, 48, 32, 32)
                listOf(url, token, start, battery, log).forEach(::addView)
            })
        })
        requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.SEND_SMS, Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    override fun onResume() {
        super.onResume()
        main.post(object : Runnable {
            override fun run() {
                log.text = synchronized(RelayService.logLines) { RelayService.logLines.joinToString("\n") }
                main.postDelayed(this, 1_000)
            }
        })
    }

    override fun onPause() {
        main.removeCallbacksAndMessages(null)
        super.onPause()
    }
}
