import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// 版本号只有一个真相源：app/package.json（docs/06 §10）。Tauri 模板在没有 tauri.properties 时
// 会落到写死的 "1.0"，于是手机「应用信息」显示一个假版本号、与应用内「关于」卡片不一致。
// 这里直接读 package.json 兜底；versionCode = major*10000 + minor*100 + patch（预发布标记不进）。
val appVersion: String by lazy {
    val parsed = groovy.json.JsonSlurper().parse(file("../../../../package.json")) as Map<*, *>
    parsed["version"] as String
}
val appVersionCode: Int by lazy {
    val parts = appVersion.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
    (parts.getOrElse(0) { 0 } * 10000) + (parts.getOrElse(1) { 0 } * 100) + parts.getOrElse(2) { 0 }
}

android {
    compileSdk = 36
    namespace = "com.moqi.projectb"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.moqi.projectb"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", appVersionCode.toString()).toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", appVersion)
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")