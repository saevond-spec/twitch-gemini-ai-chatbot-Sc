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
    versionCode = 16
    versionName = "0.1.8-dev.7-timeline"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  buildTypes {
    getByName("debug") {
      // Use a fresh ID so this build installs alongside either older app build.
      applicationIdSuffix = ".dev7timeline"
    }
  }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
}
dependencies {
  testImplementation("junit:junit:4.13.2")
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
  androidTestImplementation("androidx.test:runner:1.6.2")
  androidTestImplementation("androidx.test:rules:1.6.1")
}
