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
    versionCode = 2
    versionName = "0.1.1-dev"
  }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
}
dependencies {
  testImplementation("junit:junit:4.13.2")
}
