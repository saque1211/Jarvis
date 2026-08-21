plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "app.vexis"
  compileSdk = 34

  defaultConfig {
    applicationId = "app.vexis"
    // 24 = Android 7. Cobre praticamente qualquer aparelho vivo e evita as
    // gambiarras de WebView das versoes anteriores.
    minSdk = 24
    targetSdk = 34
    versionCode = 1
    versionName = "0.1"
  }

  buildTypes {
    // Sem minify: o app inteiro sao duas telas e um WebView, e ofuscar isso
    // so tornaria um stack trace ilegivel sem economizar nada que importe.
    release { isMinifyEnabled = false }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
}

// Sem dependencias: o app e um WebView e duas telas montadas em codigo. O
// stdlib do Kotlin ja vem pelo plugin, e cada biblioteca a mais e uma versao
// a mais pra conflitar no dia da atualizacao.
