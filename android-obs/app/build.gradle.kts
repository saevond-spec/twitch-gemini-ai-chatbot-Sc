plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}
android {
  namespace = "com.saevond.sweatyobs"
  compileSdk = 36
  defaultConfig {
    applicationId = "com.saevond.sweatyobs"
    minSdk = 29
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0-dev"
  }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
}
dependencies {
  implementation("com.github.pedroSG94.RootEncoder:library:2.8.1")
}
