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
 * O ENDERECO PADRAO agora e a nuvem — um IP de VPS, que e FIXO (nao muda como
 * o IP do PC na rede de casa mudava). Entao o app abre direto la e cai no
 * login, sem pedir nada. "Trocar endereco" continua existindo pra apontar num
 * dominio (quando houver HTTPS) ou num painel local.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private var retornoDeArquivo: ValueCallback<Array<Uri>>? = null

    companion object {
        private const val PEDIDO_ARQUIVO = 1001
        private const val PEDIDO_MIC = 1002
        private const val PREFS = "vexis"
        private const val CHAVE_ENDERECO = "endereco"
        // Servidor na nuvem — endereco fixo do VPS. Trocavel em "Trocar endereco".
        private const val PADRAO_NUVEM = "http://163.245.213.167:3000/app"
        private const val PORTA_PADRAO = 3000
        // host (letras, digitos, ponto, hifen, sublinha) e porta opcional.
        private val PADRAO_ENDERECO = Regex("^([A-Za-z0-9._-]+)(?::(\\d{1,5}))?$")

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

        // Sem endereco salvo, vai direto pra nuvem (login) em vez de pedir IP —
        // a nuvem tem endereco fixo, entao nao ha o que a pessoa precise digitar.
        val salvo = prefs().getString(CHAVE_ENDERECO, null)
        abrir(if (salvo.isNullOrBlank()) PADRAO_NUVEM else salvo)
    }

    private fun prefs() = getSharedPreferences(PREFS, MODE_PRIVATE)

    /**
     * Aceita o que a pessoa realmente digita.
     *
     * Ninguem digita "http://192.168.0.10:8791/app". Digita o IP, as vezes com
     * a porta, as vezes com uma barra no fim, as vezes com um espaco que o
     * teclado colou sozinho — e no teclado numerico do Android a virgula fica
     * onde o brasileiro procura o ponto.
     *
     * Antes isto dependia do Uri.parse, que e leniente demais pra validar e
     * severo demais pra perdoar: qualquer coisa fora do formato exato caia num
     * "endereco nao parece valido" sem dizer o que estava errado.
     */
    private fun normalizar(bruto: String): String? {
        // Todo espaco, nao so das pontas.
        var texto = bruto.replace(Regex("\\s+"), "")
        if (texto.isEmpty()) return null

        texto = texto.replace(',', '.')
        texto = texto.replace(Regex("^https?://", RegexOption.IGNORE_CASE), "")
        // Caminho a gente monta sozinho; o que interessa e host e porta.
        texto = texto.substringBefore('/')
        if (texto.isEmpty()) return null

        val achado = PADRAO_ENDERECO.find(texto) ?: return null
        val host = achado.groupValues[1]
        // "...." casa a regex e nao e endereco de nada.
        if (!host.any { it.isLetterOrDigit() }) return null

        val porta = achado.groupValues[2].takeIf { it.isNotEmpty() }?.toIntOrNull() ?: PORTA_PADRAO
        if (porta < 1 || porta > 65535) return null

        return "http://$host:$porta/app"
    }

    /**
     * O IP do proprio celular, pra sugerir a faixa da rede.
     *
     * Sai das interfaces de rede e nao do WifiManager de proposito: assim nao
     * precisa de permissao nenhuma. Quem nao sabe o IP do PC pelo menos
     * descobre que ele comeca com os mesmos tres numeros.
     */
    private fun faixaDaRede(): String? = try {
        java.net.NetworkInterface.getNetworkInterfaces().toList()
            .flatMap { it.inetAddresses.toList() }
            .firstOrNull { !it.isLoopbackAddress && it is java.net.Inet4Address }
            ?.hostAddress
            ?.substringBeforeLast('.')
    } catch (e: Exception) {
        null
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

        val faixa = faixaDaRede()
        raiz.addView(TextView(this).apply {
            text = erro ?: buildString {
                append("Onde está o painel? Rode \"npm run hud\" no PC — o terminal ")
                append("mostra o endereço da rede.")
                // A faixa some a duvida de metade das pessoas: elas nao sabem o
                // IP do PC, mas reconhecem os tres primeiros numeros quando veem.
                if (faixa != null) append("\n\nSeu celular está em $faixa.x — o PC deve estar na mesma faixa.")
            }
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
                val digitado = campo.text.toString()
                val url = normalizar(digitado)
                if (url == null) {
                    // Mostra o que CHEGOU, entre aspas. Um erro que so diz
                    // "invalido" e um beco: se o campo veio vazio aparece «»,
                    // e se o teclado meteu algo estranho da pra ver o que foi.
                    telaDeEndereco("Não entendi «$digitado». Digite só o IP, assim: 192.168.0.10")
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
                telaDeErro(url, erro?.description?.toString() ?: "sem resposta")
            }

            /**
             * Erro de HTTP e outro callback, e sem ele o app fica PRETO.
             *
             * `onReceivedError` so cobre falha de rede — cabo solto, host que
             * nao existe. Um 404 chega aqui, e se ninguem trata, o WebView
             * simplesmente desenha o corpo da resposta: como o 404 vem vazio, o
             * resultado e uma tela preta sem uma palavra explicando.
             *
             * O caso real: o PC rodando uma versao antiga do painel, que ainda
             * nao conhece a rota /app.
             */
            override fun onReceivedHttpError(
                view: WebView?,
                pedido: WebResourceRequest?,
                resposta: android.webkit.WebResourceResponse?
            ) {
                if (pedido?.isForMainFrame != true) return
                val codigo = resposta?.statusCode ?: 0
                telaDeErro(
                    url,
                    if (codigo == 404)
                        "O painel respondeu 404 — ele está rodando uma versão antiga, sem o app. Rode \"git pull\" no PC."
                    else
                        "O painel respondeu HTTP $codigo."
                )
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            /**
             * O botao de microfone do app chama getUserMedia; sem isto o WebView
             * nega por padrao e a voz nao grava. So libera o microfone — e so o
             * que o app pede. (Sobre HTTP inseguro o proprio WebView ainda pode
             * bloquear; e por isso que a voz de verdade pede HTTPS.)
             */
            override fun onPermissionRequest(pedido: android.webkit.PermissionRequest?) {
                val querMic = pedido?.resources?.contains(
                    android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE
                ) == true
                if (querMic && temPermissaoMic()) {
                    pedido?.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else if (querMic) {
                    pedirPermissaoMic()
                    pedido?.deny()
                } else {
                    pedido?.deny()
                }
            }

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

    private fun telaDeErro(url: String, motivo: String) {
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
            // O motivo primeiro, em vez de um palpite generico: "respondeu 404"
            // e "sem resposta" mandam a pessoa pra lados opostos.
            text = "$motivo\n\nEm ${curto(url)}.\n\n" +
                "O PC está ligado com \"npm run hud\"? E o celular está no mesmo Wi-Fi?"
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

    // ── microfone ─────────────────────────────────────────────────────────────

    private fun temPermissaoMic(): Boolean =
        checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED

    private fun pedirPermissaoMic() {
        requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), PEDIDO_MIC)
    }

    private fun dp(valor: Int): Int =
        (valor * resources.displayMetrics.density).toInt()
}
