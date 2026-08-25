package com.loop

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.loop.source.LoopSourceModule
import com.loop.source.LoopSourcePackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Provider registration.
          //
          // When the native source ships as its own npm package, autolinking
          // adds it to PackageList automatically and this line disappears —
          // installing/uninstalling the package becomes the entire swap. It is
          // explicit here only because the provider lives in this repo.
          add(LoopSourcePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }

  /**
   * The platform's actual low-memory signal — not a proxy for it.
   *
   * `Application` implements `ComponentCallbacks2` and receives this from the
   * OS directly, including while the app is fully in the foreground under real
   * memory pressure. That is precisely the case an `AppState` background
   * listener cannot observe, since nothing about foreground/background changed.
   *
   * Forwarded to the TurboModule rather than handled here: MainApplication
   * knows the signal exists, not what shedding means, and the module already
   * owns the emitter to JS.
   */
  override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    LoopSourceModule.notifyTrimMemory(level)
  }
}
