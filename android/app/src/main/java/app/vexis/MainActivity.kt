package app.vexis

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * VEXIS no Android.
 *
 * E um WebView apontado pro painel da sua casa, e nao um app nativo de novo,
 * porque a tela ja existe e ja funciona: reescrever as cinco abas em Kotlin
 * criaria uma segunda verdade pra manter em dia toda vez que uma preferencia
 * mudasse. O que o wrapper acrescenta e o que o navegador nao da — icone na
 * gaveta, tela cheia sem barra de endereco, e o seletor de arquivos ligado no
 * botao de enviar foto.
 *
 * O ENDERECO nao e fixo no codigo de proposito. O IP do PC muda quando o
 * roteador reinicia, e um APK com IP embutido vira lixo naquele dia — a
 * pessoa teria que esperar alguem recompilar.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private var retornoDeArquivo: ValueCallback<Array<Uri>>? = null

    companion object {
        private const val PEDIDO_ARQUIVO = 1001
        private const val PREFS = "vexis"
        private const val CHAVE_ENDERECO = "endereco"
        private const val PORTA_PADRAO = 8791

        private const val AZUL = 0xFF0088B0.toInt()
        private const val AZUL_CLARO = 0xFF4FD6EE.toInt()
        private const val FUNDO = 0xFF06090C.toInt()
        private const val FRACO = 0xFF8C9498.toInt()
    }

    // ── ciclo de vida ────────────────────────────────────────────────────────

    override fun onCreate(estado: Bundle?) {
        super.onCreate(estado)
        window.statusBarColor = FUNDO
        window.navigationBarColor = FUNDO

        val salvo = prefs().getString(CHAVE_ENDERECO, null)
        if (salvo.isNullOrBlank()) telaDeEndereco(null) else abrir(salvo)
    }

    private fun prefs() = getSharedPreferences(PREFS, MODE_PRIVATE)

    /**
     * Aceita o que a pessoa realmente digita.
     *
     * Ninguem digita "http://192.168.0.10:8791/app" — digita "192.168.0.10", ou
     * cola com a porta, ou poe uma barra no fim. Exigir a forma completa
     * transformaria a primeira tela numa armadilha.
     */
    private fun normalizar(bruto: String): String? {
        var texto = bruto.trim()
        if (texto.isEmpty()) return null
        if (!texto.startsWith("http://") && !texto.startsWith("https://")) {
            texto = "http://$texto"
        }
        val uri = Uri.parse(texto)
        val host = uri.host ?: return null
        if (host.isBlank()) return null
        val porta = if (uri.port > 0) uri.port else PORTA_PADRAO
        return "http://$host:$porta/app"
    }

    // ── primeira tela ────────────────────────────────────────────────────────

    private fun telaDeEndereco(erro: String?) {
        val raiz = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(FUNDO)
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(28), dp(28), dp(28), dp(28))
        }

        raiz.addView(TextView(this).apply {
            text = "VEXIS"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 34f)
        })

        raiz.addView(TextView(this).apply {
            text = erro ?: "Onde está o painel? Rode \"npm run hud\" no PC — " +
                "o terminal mostra o endereço da rede."
            setTextColor(if (erro != null) AZUL_CLARO else FRACO)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setPadding(0, dp(10), 0, dp(22))
        })

        val campo = EditText(this).apply {
            hint = "192.168.0.10"
            setText(prefs().getString(CHAVE_ENDERECO, "")?.let { curto(it) } ?: "")
            setTextColor(Color.WHITE)
            setHintTextColor(FRACO)
            // O teclado de URI tem ponto e digitos na primeira camada, que e o
            // que se digita aqui — o alfabetico obriga a trocar de camada.
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine()
            setPadding(dp(14), dp(14), dp(14), dp(14))
        }
        raiz.addView(campo)

        raiz.addView(Button(this).apply {
            text = "Conectar"
            setTextColor(Color.WHITE)
            setBackgroundColor(AZUL)
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dp(16)
            layoutParams = lp
            setOnClickListener {
                val url = normalizar(campo.text.toString())
                if (url == null) {
                    telaDeEndereco("Endereço não parece válido. Ex: 192.168.0.10")
                } else {
                    prefs().edit().putString(CHAVE_ENDERECO, url).apply()
                    abrir(url)
                }
            }
        })

        setContentView(raiz)
    }

    /** "http://192.168.0.10:8791/app" → "192.168.0.10:8791", pra reeditar. */
    private fun curto(url: String): String =
        url.removePrefix("http://").removePrefix("https://").removeSuffix("/app")

    // ── o painel ─────────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun abrir(url: String) {
        web = WebView(this)
        web.setBackgroundColor(FUNDO)

        web.settings.apply {
            javaScriptEnabled = true
            // O app guarda aba escolhida e rascunhos no localStorage; sem isto
            // ele esquece tudo a cada abertura.
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }

        web.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView?,
                pedido: WebResourceRequest?,
                erro: WebResourceError?
            ) {
                // So o carregamento da PAGINA importa. Um icone que falhou nao
                // pode jogar a pessoa de volta pra tela de configuracao.
                if (pedido?.isForMainFrame != true) return
                telaDeErro(url)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            /**
             * Sem isto o botao "Enviar foto" nao faz NADA dentro de um WebView.
             * Nao da erro, nao abre nada — e o defeito que faz o app parecer
             * quebrado justamente na funcao que motivou ele existir.
             */
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                // Um seletor pendente que nunca respondeu trava o input pra
                // sempre. Fecha o anterior antes de abrir outro.
                retornoDeArquivo?.onReceiveValue(null)
                retornoDeArquivo = callback

                return try {
                    startActivityForResult(params!!.createIntent(), PEDIDO_ARQUIVO)
                    true
                } catch (e: Exception) {
                    retornoDeArquivo = null
                    false
                }
            }
        }

        setContentView(web)
        web.loadUrl(url)
    }

    private fun telaDeErro(url: String) {
        val raiz = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(FUNDO)
            gravity = Gravity.CENTER
            setPadding(dp(28), dp(28), dp(28), dp(28))
        }

        raiz.addView(TextView(this).apply {
            text = "Não achei o painel"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            gravity = Gravity.CENTER
        })

        raiz.addView(TextView(this).apply {
            text = "Em ${curto(url)}.\n\nO PC está ligado com \"npm run hud\"? " +
                "E o celular está no mesmo Wi-Fi?"
            setTextColor(FRACO)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, dp(26))
        })

        raiz.addView(Button(this).apply {
            text = "Tentar de novo"
            setTextColor(Color.WHITE)
            setBackgroundColor(AZUL)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
            setOnClickListener { abrir(url) }
        })

        // O IP do PC muda quando o roteador reinicia, e este e o unico lugar
        // do app onde da pra consertar isso sem reinstalar.
        raiz.addView(Button(this).apply {
            text = "Trocar endereço"
            setTextColor(AZUL_CLARO)
            setBackgroundColor(Color.TRANSPARENT)
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dp(8)
            layoutParams = lp
            setOnClickListener { telaDeEndereco(null) }
        })

        setContentView(raiz)
    }

    // ── seletor de arquivos ──────────────────────────────────────────────────

    // startActivityForResult esta deprecado em favor do ActivityResult API,
    // que exige ComponentActivity — e trazer o AndroidX inteiro pra isso num
    // app de duas telas nao se paga. Suprimido de propriedade, nao por descuido.
    @Suppress("DEPRECATION")
    override fun onActivityResult(pedido: Int, resultado: Int, dados: Intent?) {
        super.onActivityResult(pedido, resultado, dados)
        if (pedido != PEDIDO_ARQUIVO) return

        val callback = retornoDeArquivo ?: return
        retornoDeArquivo = null
        // parseResult devolve null quando a pessoa cancelou — e o WebView
        // PRECISA receber esse null, senao o <input type=file> fica travado e
        // nao abre mais.
        callback.onReceiveValue(
            WebChromeClient.FileChooserParams.parseResult(resultado, dados)
        )
    }

    // ── voltar ───────────────────────────────────────────────────────────────

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        // Voltar dentro do app antes de sair dele: e o que o botao de voltar
        // significa pra quem esta usando.
        if (this::web.isInitialized && web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    private fun dp(valor: Int): Int =
        (valor * resources.displayMetrics.density).toInt()
}
