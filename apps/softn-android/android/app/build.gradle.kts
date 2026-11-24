plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val softnAppId = System.getenv("SOFTN_APP_ID") ?: (project.findProperty("softnAppId") as String?) ?: "com.softn.android"
val softnAppName = System.getenv("SOFTN_APP_NAME") ?: (project.findProperty("softnAppName") as String?) ?: "SoftN"
val softnVersionName = System.getenv("SOFTN_VERSION_NAME") ?: (project.findProperty("softnVersionName") as String?) ?: "1.0.0"
val softnVersionCode = (System.getenv("SOFTN_VERSION_CODE") ?: (project.findProperty("softnVersionCode") as String?))?.toIntOrNull() ?: 1
val softnManifestFile = System.getenv("SOFTN_MANIFEST_FILE") ?: (project.findProperty("softnManifestFile") as String?)
val softnAssetsDir = System.getenv("SOFTN_ASSETS_DIR") ?: (project.findProperty("softnAssetsDir") as String?)

fun escapeAndroidStringRes(raw: String): String {
    val sb = StringBuilder(raw.length + 16)
    var first = true
    for (ch in raw) {
        if (first && (ch == '@' || ch == '?')) {
            sb.append('\\').append(ch)
            first = false
            continue
        }
        when (ch) {
            '&' -> { sb.append("&amp;"); first = false }
            '<' -> { sb.append("&lt;"); first = false }
            '>' -> { sb.append("&gt;"); first = false }
            '"' -> { sb.append("\\\""); first = false }
            '\'' -> { sb.append("\\'"); first = false }
            '\\' -> { sb.append("\\\\"); first = false }
            '\n' -> { sb.append("\\n"); first = false }
            '\r' -> {}
            else -> if (ch.code >= 0x20) { sb.append(ch); first = false }
        }
    }
    return sb.toString()
}

val releaseKeystorePath = System.getenv("SOFTN_KEYSTORE_FILE") ?: (project.findProperty("softnKeystoreFile") as String?)
val releaseKeystorePassword = System.getenv("SOFTN_KEYSTORE_PASSWORD") ?: (project.findProperty("softnKeystorePassword") as String?)
val releaseKeyAlias = System.getenv("SOFTN_KEY_ALIAS") ?: (project.findProperty("softnKeyAlias") as String?)
val releaseKeyPassword = System.getenv("SOFTN_KEY_PASSWORD") ?: (project.findProperty("softnKeyPassword") as String?)
val allowDebugReleaseSigning = (System.getenv("SOFTN_ALLOW_DEBUG_RELEASE_SIGNING") ?: (project.findProperty("softnAllowDebugReleaseSigning") as String?)) == "1"

android {
    namespace = "com.softn.android"
    compileSdk = 35

    defaultConfig {
        applicationId = softnAppId
        minSdk = 26
        targetSdk = 35
        versionCode = softnVersionCode
        versionName = softnVersionName

        resValue("string", "app_name", escapeAndroidStringRes(softnAppName))
        manifestPlaceholders["appAuthProvider"] = "$softnAppId.fileprovider"
    }

    signingConfigs {
        if (!releaseKeystorePath.isNullOrBlank() && !releaseKeystorePassword.isNullOrBlank() && !releaseKeyAlias.isNullOrBlank()) {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword ?: releaseKeystorePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.findByName("release")
                ?: if (allowDebugReleaseSigning) signingConfigs.getByName("debug") else null
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main") {
            if (softnManifestFile != null) {
                manifest.srcFile(file(softnManifestFile))
            }
            if (softnAssetsDir != null) {
                assets.srcDirs("src/main/assets", softnAssetsDir)
            }
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
