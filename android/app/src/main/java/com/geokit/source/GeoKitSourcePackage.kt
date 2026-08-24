package com.geokit.source

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.geokit.specs.NativeGeoKitSourceSpec

/**
 * ReactPackage for the native source provider.
 *
 * THIS IS THE SWAP MECHANISM.
 *
 * In the production layout this package ships as its own npm module with its
 * own Android library. React Native's autolinking then discovers it and adds it
 * to the generated `PackageList` automatically — so installing or uninstalling
 * the package is the entire provider swap, with no edit anywhere in JS and no
 * edit in MainApplication either.
 *
 * Here it is registered manually in MainApplication so the whole mechanism
 * stays readable in one repository, but the discovery path is identical: a
 * ReactPackage contributes the module, and the JS-side registry resolves
 * whichever provider is present.
 *
 * `BaseReactPackage` (rather than the older ReactPackage) is what the New
 * Architecture wants: modules are constructed lazily on first use via
 * `getModule`, so an unused provider costs nothing at startup.
 */
class GeoKitSourcePackage : BaseReactPackage() {

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == NativeGeoKitSourceSpec.NAME) GeoKitSourceModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            NativeGeoKitSourceSpec.NAME to
                ReactModuleInfo(
                    /* name = */ NativeGeoKitSourceSpec.NAME,
                    /* className = */ NativeGeoKitSourceSpec.NAME,
                    /* canOverrideExistingModule = */ false,
                    /* needsEagerInit = */ false,
                    /* isCxxModule = */ false,
                    /* isTurboModule = */ true,
                ),
        )
    }
}
