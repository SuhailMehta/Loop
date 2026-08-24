# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# ---------------------------------------------------------------------------
# GeoKit keep rules
#
# R8 is enabled for release. Everything below is reached via JNI or reflection,
# where R8's static reachability analysis cannot see the call site — so without
# these the build succeeds and then crashes at runtime, which is the worst
# possible failure mode.
# ---------------------------------------------------------------------------

# MapLibre native SDK. The Java layer is called from C++ across JNI for every
# map event, source update and style operation.
-keep class org.maplibre.** { *; }
-keep interface org.maplibre.** { *; }
-dontwarn org.maplibre.**

# Reanimated / Worklets: JNI bridge plus runtime-generated worklet classes.
-keep class com.swmansion.reanimated.** { *; }
-keep class com.swmansion.worklets.** { *; }
-dontwarn com.swmansion.**

# Facebook JNI plumbing shared by React Native's C++ layer.
-keep class com.facebook.jni.** { *; }

# React Native ships consumer ProGuard rules for its own classes, so the core
# framework needs nothing here. Native modules and Fabric components added
# later (the TurboModule source) must be kept explicitly if they are resolved
# by name rather than by a generated spec.

# GeoKit TurboModule provider. The generated spec carries @DoNotStrip on its
# methods, but the concrete module and its package are resolved partly by name
# through ReactModuleInfo, so keep both explicitly.
-keep class com.geokit.specs.** { *; }
-keep class com.geokit.source.** { *; }
