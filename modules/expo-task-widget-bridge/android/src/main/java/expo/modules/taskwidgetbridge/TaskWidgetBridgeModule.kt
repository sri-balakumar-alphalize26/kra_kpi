package expo.modules.taskwidgetbridge

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * One job: let JavaScript ask Android to redraw the running-task widget.
 *
 * WHY THIS EXISTS. The app has always written the widget's state file correctly
 * (utils/taskWidget.js, on every live-status poll), and TaskWidgetProvider has
 * always read it. What was missing is the nudge in between: only native code can
 * broadcast APPWIDGET_UPDATE, so with no native module the widget was repainted
 * solely by android:updatePeriodMillis — whose floor is 30 minutes. Switch task
 * and the widget kept showing the old task's NAME for up to half an hour. (The
 * timer was always right; the Chronometer ticks on its own.)
 *
 * WHY A LOCAL MODULE AND NOT A CONFIG PLUGIN. This project is pure CNG — android/
 * is gitignored and regenerated on every build, so files written there are thrown
 * away. A config plugin *could* drop Kotlin at prebuild, but a bridge module must
 * also be registered in MainApplication.kt's package list, which means patching a
 * generated file by regex. Expo modules under modules/ are discovered by
 * autolinking instead, survive prebuild, and are tracked by git so EAS uploads
 * them. ("./modules" is autolinking's default nativeModulesDir, which is why
 * package.json needs no expo.autolinking block.)
 */
class TaskWidgetBridgeModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  // Default kept so every existing caller — refreshTaskWidget() — keeps working
  // unchanged. There is more than one provider now (the running task and admin
  // Live Tracking), so the name is a parameter rather than a constant.
  private fun providerFor(name: String?): ComponentName {
    // Addressed by NAME, not by class. The providers are emitted by the config
    // plugins into the APP's package, so referencing the class here would make
    // this module depend on app sources it cannot see.
    val simple = if (name.isNullOrBlank()) "TaskWidgetProvider" else name
    return ComponentName(context.packageName, "${context.packageName}.$simple")
  }

  // The ids the launcher currently holds for that provider, or an empty array if
  // the provider is absent (an older build, or the plugin did not run). A widget
  // that cannot be found is never a reason to fail the caller.
  private fun idsFor(provider: ComponentName): IntArray =
    try {
      AppWidgetManager.getInstance(context).getAppWidgetIds(provider) ?: IntArray(0)
    } catch (e: Exception) {
      IntArray(0)
    }

  override fun definition() = ModuleDefinition {
    // Must match requireNativeModule('TaskWidgetBridge') in index.js. Deliberately
    // NOT renamed now that it serves two widgets — a rename buys nothing and has
    // to be matched on the JS side.
    Name("TaskWidgetBridge")

    // Returns true when at least one widget was asked to redraw, false when the
    // user has none on their home screen. Not an error either way — most people
    // never add the widget, and a caller must not treat that as a failure.
    Function("refreshWidget") { providerName: String? ->
      val provider = providerFor(providerName)
      val ids = idsFor(provider)
      if (ids.isEmpty()) return@Function false

      // Targeted with the ComponentName already built above rather than
      // Intent(context, SomeClass::class.java): that form needs the class
      // LOADED, which would mean Class.forName and a second failure mode to
      // handle. setComponent takes the name as data and never touches the
      // classloader. Explicit and same-package either way, so exported="false"
      // on the receiver is irrelevant — that only gates other apps.
      val intent = Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
        .setComponent(provider)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
      context.sendBroadcast(intent)
      true
    }

    // Is this widget actually on somebody's home screen?
    //
    // Exists so the app can skip work nobody will see. The Live Tracking widget
    // is fed by its own extra RPC to an admin-only route; without this every
    // admin would pay for that poll forever, when most will never add the widget.
    // Cheap: one AppWidgetManager lookup, no broadcast.
    Function("widgetPlaced") { providerName: String? ->
      idsFor(providerFor(providerName)).isNotEmpty()
    }

    // Show or hide a widget in Android's WIDGET PICKER.
    //
    // WHY THIS IS NEEDED. The picker is the OS's, and it knows nothing about who
    // is signed in. Live Tracking is admin-only — the route behind it is gated
    // server-side to Owner/Coordinator/System — so without this a developer would
    // see it when they long-press the home screen, add it, and get a permanently
    // empty box. An empty widget reads as a broken app, not as "not for you".
    //
    // Disabling the RECEIVER COMPONENT is the only way to take an entry out of
    // that picker; there is no per-user filter. The Live Tracking receiver is
    // therefore declared android:enabled="false" in the manifest and switched on
    // only once a role resolves to admin, so the default state is the safe one.
    //
    // DONT_KILL_APP because the alternative is Android restarting the process
    // mid-session to apply a cosmetic change.
    //
    // Returns false rather than throwing when the component is absent (an older
    // build): a widget that cannot be found must never break signing in.
    Function("setWidgetEnabled") { providerName: String?, enabled: Boolean ->
      try {
        val state = if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                    else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        context.packageManager.setComponentEnabledSetting(
          providerFor(providerName), state, PackageManager.DONT_KILL_APP,
        )
        true
      } catch (e: Exception) {
        false
      }
    }
  }
}
