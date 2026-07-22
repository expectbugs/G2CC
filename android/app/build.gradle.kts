import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

// Harness build secrets (gitignored). Bakes the auth token + Tailscale server
// address into BuildConfig so the sideloaded harness APK needs no setup screen.
// Falls back to empty/defaults if the file is absent (e.g. CI) — the harness
// surfaces a missing token loudly at Connect time rather than silently failing.
val harnessProps = Properties().apply {
    val f = rootProject.file("harness-secrets.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.g2cc.g2cc"
    compileSdk = 35
    // Explicit pin: AGP 8.7.x defaults to build-tools 34.0.0 (auto-install).
    // Adam's /opt/android-sdk only has 35.0.0 installed AND is system-owned
    // (non-writable for user → auto-install of an older buildTools fails).
    // Match what's actually present.
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.g2cc.g2cc"
        // Min SDK 29 per spec §13 (stable foreground-service APIs).
        minSdk = 29
        // Target SDK 35 = Android 15.
        targetSdk = 35
        // THE version source of truth (2026-07-22 — was a static 1/"0.0.1" on
        // every APK ever shipped, so Android couldn't tell builds apart and a
        // stale Downloads-folder file was indistinguishable from a fresh one).
        // Bump BOTH on every build Adam will install: versionCode = major*100
        // + minor (1.19 → 119) so upgrades are monotonic and an old download
        // now REFUSES to install over a newer build (a loud downgrade error
        // beats silently running old code). OsLayout.OS_VERSION reads
        // BuildConfig.VERSION_NAME — one bump updates the splash/antenna too.
        versionCode = 119
        versionName = "1.19"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Hardcoded harness config (from gitignored harness-secrets.properties).
        buildConfigField("String", "AUTH_TOKEN", "\"${harnessProps.getProperty("authToken", "")}\"")
        buildConfigField("String", "SERVER_HOST", "\"${harnessProps.getProperty("serverHost", "100.107.139.121")}\"")
        buildConfigField("int", "SERVER_PORT", harnessProps.getProperty("serverPort", "7300"))
    }

    // THE signing identity (2026-07-22 — ends the "App not installed" roulette).
    // TWO default debug keystores existed on this box (~/.android/debug.keystore,
    // Jun 4 + ~/.config/.android/debug.keystore, Jun 1) and gradle picked one by
    // the SESSION'S environment — so ~1 in 5 staged builds carried the cert the
    // phone doesn't trust and the sideload failed with the generic dialog. The
    // phone's install lineage is the Jun-1 key; it now lives CANONICALLY at
    // ~/.g2cc/g2cc-debug.keystore and is pinned here EXPLICITLY. Deliberately NO
    // exists() fallback: a missing keystore must FAIL THE BUILD loudly, never
    // silently sign with whatever ambient key the environment resolves.
    signingConfigs {
        getByName("debug") {
            storeFile = file("/home/user/.g2cc/g2cc-debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/kotlin")
        }
        getByName("test") {
            java.srcDirs("src/test/kotlin")
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.preference)
    implementation(libs.material)
    implementation(libs.kotlinx.coroutines.android)
    // Phase 5: BLE driver via Nordic Android-BLE-Library.
    implementation(libs.nordic.ble)
    implementation(libs.nordic.ble.ktx)
    // Phase 6: WebSocket client + JSON serialization.
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)

    // ZXing core for QR decode (no-op dependency-wise; activated when QR scan path is wired).
    implementation(libs.zxing.core)

    testImplementation("junit:junit:4.13.2")
}
