plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.g2cc.g2cc"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.g2cc.g2cc"
        // Min SDK 29 per spec §13 (stable foreground-service APIs).
        minSdk = 29
        // Target SDK 35 = Android 15.
        targetSdk = 35
        versionCode = 1
        versionName = "0.0.1"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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
