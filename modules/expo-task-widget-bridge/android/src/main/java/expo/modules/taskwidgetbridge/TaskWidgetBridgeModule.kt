package expo.modules.taskwidgetbridge

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
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

  override fun definition() = ModuleDefinition {
    // Must match requireNativeModule('TaskWidgetBridge') in index.js.
    Name("TaskWidgetBridge")

    // Returns true when at least one widget was asked to redraw, false when the
    // user has none on their home screen. Not an error either way — most people
    // never add the widget, and a caller must not treat that as a failure.
    Function("refreshWidget") {
      val mgr = AppWidgetManager.getInstance(context)

      // Addressed by NAME, not by class. TaskWidgetProvider is emitted by
      // plugins/withTaskWidget.js into the APP's package, so referencing the
      // class here would make this module depend on app sources it cannot see.
      val provider = ComponentName(context.packageName, "${context.packageName}.TaskWidgetProvider")

      val ids = try {
        mgr.getAppWidgetIds(provider)
      } catch (e: Exception) {
        // The provider is absent (older build, or the plugin did not run). A
        // widget that cannot be found is not a reason to fail a task switch.
        return@Function false
      }
      if (ids == null || ids.isEmpty()) return@Function false

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
  }
}
