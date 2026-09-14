# Panduan Penggunaan Codex API Proxy melalui Tailscale

Dokumen ini menjelaskan cara memakai Codex API Proxy milik tim dari perangkat
lain melalui jaringan privat Tailscale. Proxy menyediakan sebagian antarmuka
OpenAI Chat Completions dan menjalankan Codex CLI pada komputer server.

Terakhir diperbarui: 14 September 2026.

## Ringkasan koneksi

| Pengaturan | Nilai |
| --- | --- |
| Base URL | `https://spark-2209.tail921925.ts.net:8443/v1` |
| Chat Completions | `https://spark-2209.tail921925.ts.net:8443/v1/chat/completions` |
| Daftar model | `https://spark-2209.tail921925.ts.net:8443/v1/models` |
| Health check | `https://spark-2209.tail921925.ts.net:8443/health` |
| API type | OpenAI-compatible Chat Completions |
| Autentikasi | `Authorization: Bearer <API_KEY>` |
| Model yang disarankan | `codex` |
| Akses jaringan | Hanya perangkat yang diizinkan di tailnet |

Endpoint ini bukan endpoint publik. Perangkat klien harus terhubung ke tailnet
yang sama dan diizinkan oleh kebijakan akses Tailscale.

## Cara kerjanya

Alur sebuah permintaan adalah:

```text
Perangkat rekan
    -> HTTPS melalui Tailscale
    -> Tailscale Serve pada server
    -> Codex API Proxy di 127.0.0.1:3456
    -> codex exec
    -> layanan OpenAI menggunakan sesi Codex milik server
```

API key pada panduan ini melindungi proxy. Key tersebut bukan OpenAI API key.
Semua pemakaian model menggunakan autentikasi dan kuota Codex yang terpasang
pada komputer server.

## Prasyarat perangkat klien

1. Instal Tailscale pada perangkat yang akan digunakan.
2. Masuk menggunakan akun yang sudah menjadi anggota atau sudah diberi akses
   ke tailnet server.
3. Pastikan perangkat bernama `spark-2209` terlihat dan berstatus online.
4. Minta API key proxy kepada pengelola server melalui sarana berbagi rahasia
   yang aman.

Komputer server harus menyala, terhubung ke internet, dan berstatus online di
Tailscale. Service proxy sudah dikonfigurasi agar aktif otomatis setelah server
restart.

## Memeriksa koneksi Tailscale

Jalankan dari perangkat klien:

```bash
tailscale status
tailscale ping spark-2209
```

Kemudian periksa endpoint kesehatan:

```bash
curl --fail --silent --show-error \
  https://spark-2209.tail921925.ts.net:8443/health
```

Respons yang diharapkan:

```json
{
  "status": "ok",
  "provider": "codex-cli",
  "timestamp": "2026-09-13T00:00:00.000Z"
}
```

Health check tidak memerlukan API key. Endpoint di bawah `/v1` memerlukan API
key.

## Menyimpan API key pada perangkat klien

Jangan memasukkan placeholder seperti `API_KEY_ANDA` secara harfiah. Ganti
dengan key asli yang diberikan pengelola server.

### Linux dan macOS

Untuk sesi terminal saat ini:

```bash
export CODEX_PROXY_API_KEY='PASTE_KEY_ASLI_DI_SINI'
```

### Windows PowerShell

```powershell
$env:CODEX_PROXY_API_KEY = "PASTE_KEY_ASLI_DI_SINI"
```

Hindari menyimpan key di repositori, issue, pesan grup, tangkapan layar, atau
file konfigurasi yang ikut disinkronkan tanpa enkripsi.

## Permintaan pertama dengan curl

### Linux dan macOS

```bash
curl --fail --silent --show-error \
  https://spark-2209.tail921925.ts.net:8443/v1/chat/completions \
  -H "Authorization: Bearer $CODEX_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex",
    "reasoning_effort": "high",
    "messages": [
      {
        "role": "user",
        "content": "Jelaskan kegunaan dependency utama proyek ini."
      }
    ]
  }'
```

### Windows PowerShell

Gunakan `curl.exe` agar sintaksnya tidak dialihkan ke cmdlet PowerShell:

```powershell
curl.exe --fail --silent --show-error `
  "https://spark-2209.tail921925.ts.net:8443/v1/chat/completions" `
  -H "Authorization: Bearer $env:CODEX_PROXY_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"model":"codex","messages":[{"role":"user","content":"Balas dengan kata OK"}]}'
```

Contoh respons non-streaming:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1789290299,
  "model": "codex",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "OK"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 10,
    "total_tokens": 110
  }
}
```

## Model yang dapat dipilih

Nilai `model` diteruskan ke opsi `codex exec --model`. Pilihan yang tersedia
bergantung pada paket ChatGPT/Codex, metode login, kebijakan workspace, client,
dan tahap rollout akun yang digunakan komputer server.

| Nilai `model` | Kegunaan | Catatan |
| --- | --- | --- |
| `codex` | Pilihan utama untuk penggunaan umum | Mengikuti model default pada konfigurasi Codex CLI server |
| `gpt-6-astra` | Pekerjaan end-to-end paling sulit, coding, riset, dan penalaran mendalam | Model paling mampu; akses dapat bergantung pada paket dan rollout |
| `gpt-5.6-sol` | Coding kompleks, analisis, riset, dan pekerjaan yang memerlukan kualitas tinggi | Model GPT-5.6 paling mampu |
| `gpt-5.6` | Alias praktis GPT-5.6 | Saat ini merupakan alias untuk `gpt-5.6-sol` |
| `gpt-5.6-terra` | Pekerjaan harian dengan keseimbangan kemampuan dan biaya | Pilihan umum yang seimbang |
| `gpt-5.6-luna` | Tugas jelas, berulang, cepat, atau bervolume tinggi | Pilihan paling hemat pada keluarga GPT-5.6 |
| `gpt-5.5` | Coding dan pekerjaan umum generasi sebelumnya | Gunakan bila kompatibilitas dengan perilaku GPT-5.5 diperlukan |
| `gpt-5.3-codex-spark` | Iterasi coding teks dengan latensi sangat rendah | Research preview dan tersedia untuk akun ChatGPT Pro yang memenuhi syarat |

Gunakan `codex` jika tidak yakin. Alias tersebut membuat server memakai pilihan
default yang memang tersedia untuk akun server. Jika model eksplisit tidak
tersedia, Codex CLI akan mengembalikan error.

Endpoint `GET /v1/models` mengiklankan alias `codex` dan seluruh ID model pada
tabel. Model eksplisit diteruskan langsung ke `codex exec --model`.

Contoh memilih model eksplisit:

```bash
curl --fail --silent --show-error \
  https://spark-2209.tail921925.ts.net:8443/v1/chat/completions \
  -H "Authorization: Bearer $CODEX_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-terra",
    "messages": [
      {"role": "user", "content": "Tinjau rancangan fungsi ini."}
    ]
  }'
```

Daftar model dapat berubah. Periksa halaman model Codex resmi sebelum
mendistribusikan ulang daftar ini:

- <https://developers.openai.com/codex/models>
- <https://developers.openai.com/api/docs/models>

## Mengatur reasoning effort

Tambahkan field `reasoning_effort` pada setiap request untuk mengatur banyaknya
penalaran yang digunakan Codex pada turn tersebut:

```json
{
  "model": "codex",
  "reasoning_effort": "high",
  "messages": [
    {"role": "user", "content": "Analisis penyebab bug ini secara teliti."}
  ]
}
```

Nilai yang diterima proxy:

| Tampilan/nilai API | Nilai yang dikirim ke Codex | Catatan |
| --- | --- | --- |
| `none` | `none` | Tanpa reasoning tambahan; hanya model tertentu |
| `minimal` | `minimal` | Reasoning paling sedikit; hanya model tertentu |
| `light` atau `low` | `low` | Pilihan ringan dan cepat |
| `medium` | `medium` | Keseimbangan kecepatan dan penalaran |
| `high` | `high` | Penalaran lebih dalam |
| `extra-high`, `extra_high`, `extra high`, atau `xhigh` | `xhigh` | Nama CLI untuk Extra High |
| `max` | `max` | Tingkat tertinggi pada model yang mendukungnya |

Jika field ini tidak dikirim, proxy mengikuti `model_reasoning_effort` pada
konfigurasi Codex CLI server. Tidak semua model mendukung semua tingkat; bila
kombinasinya tidak tersedia, Codex CLI akan mengembalikan error. `ultra` bukan
nilai reasoning effort per request karena mode tersebut mengatur orkestrasi
multi-agent Codex.

## Streaming SSE

Tambahkan `"stream": true` dan gunakan `curl -N`:

```bash
curl -N --fail --show-error \
  https://spark-2209.tail921925.ts.net:8443/v1/chat/completions \
  -H "Authorization: Bearer $CODEX_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Buat ringkasan singkat tentang REST API."}
    ]
  }'
```

Respons menggunakan `text/event-stream`, diakhiri dengan:

```text
data: [DONE]
```

Codex mengirimkan teks ketika item pesan selesai. Karena itu, alirannya tidak
selalu muncul token demi token.

## Percakapan berkelanjutan

Tambahkan nilai `user` yang stabil agar proxy melanjutkan thread Codex yang
sama:

```json
{
  "model": "codex",
  "user": "nama-rekan-proyek-a",
  "messages": [
    {"role": "user", "content": "Ingat bahwa kode proyek ini adalah ORBIT."}
  ]
}
```

Pada permintaan selanjutnya, kirim nilai `user` yang sama. Gunakan nilai unik
per pengguna dan per percakapan agar konteks rekan yang berbeda tidak
tercampur.

Pemetaan sesi disimpan di memori server selama enam jam. Pemetaan hilang saat
service restart. Klien tetap sebaiknya mengirimkan riwayat `messages` yang
relevan.

## Konfigurasi Visual Studio Code

Endpoint ini dapat digunakan sebagai model BYOK pada fitur Chat bawaan VS Code.
Di VS Code, jalankan **Chat: Manage Language Models**, pilih **Add Models**,
lalu pilih **Custom Endpoint**. Masukkan API key saat diminta dan pilih API type
**Chat Completions**.

Jika perlu mengedit `chatLanguageModels.json` secara manual, gunakan:

```json
[
  {
    "name": "Codex Tailscale",
    "vendor": "customendpoint",
    "apiKey": "PASTE_KEY_ASLI_DI_SINI",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "codex",
        "name": "Codex CLI Default",
        "url": "https://spark-2209.tail921925.ts.net:8443/v1/chat/completions",
        "toolCalling": false,
        "vision": false,
        "streaming": true,
        "thinking": true,
        "supportsReasoningEffort": ["low", "medium", "high", "xhigh", "max"],
        "reasoningEffortFormat": "chat-completions",
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      },
      {
        "id": "gpt-5.6-terra",
        "name": "Codex 5.6 Terra",
        "url": "https://spark-2209.tail921925.ts.net:8443/v1/chat/completions",
        "toolCalling": false,
        "vision": false,
        "streaming": true,
        "thinking": true,
        "supportsReasoningEffort": ["none", "low", "medium", "high", "xhigh", "max"],
        "reasoningEffortFormat": "chat-completions",
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      },
      {
        "id": "gpt-5.6-luna",
        "name": "Codex 5.6 Luna",
        "url": "https://spark-2209.tail921925.ts.net:8443/v1/chat/completions",
        "toolCalling": false,
        "vision": false,
        "streaming": true,
        "thinking": true,
        "supportsReasoningEffort": ["none", "low", "medium", "high", "xhigh", "max"],
        "reasoningEffortFormat": "chat-completions",
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      }
    ]
  }
]
```

Setelah menyimpan file, jalankan **Developer: Reload Window**. Jangan commit
file tersebut jika berisi key mentah. Dokumentasi VS Code menyarankan memakai
input variable atau penyimpanan rahasia yang disediakan UI:

- <https://code.visualstudio.com/docs/agent-customization/language-models>

### Batasan integrasi VS Code

Konfigurasi Custom Endpoint menyediakan model untuk Chat/BYOK VS Code. Proxy
saat ini tidak menghasilkan OpenAI `tool_calls`, sehingga `toolCalling` harus
tetap `false`. Model mungkin tidak tersedia untuk Agent mode yang mensyaratkan
tool calling.

Endpoint juga tidak dapat membaca file yang berada di perangkat klien hanya
karena file tersebut sedang dibuka di VS Code. Prompt diproses oleh Codex CLI
di komputer server.

Untuk pengalaman coding agent penuh pada file server, gunakan VS Code Remote
SSH melalui Tailscale, buka proyek di server, lalu jalankan Codex CLI atau
ekstensi Codex di sesi remote.

## Konfigurasi Continue

Untuk ekstensi Continue, setiap model memakai `provider: openai` dan base URL
yang berhenti pada `/v1`. Tulis URL mentah sebagai nilai YAML; jangan salin
format tautan Markdown `[URL](URL)`.

```yaml
name: Main Config
version: 1.0.0
schema: v1

models:
  - name: Codex Default
    provider: openai
    model: codex
    apiBase: https://spark-2209.tail921925.ts.net:8443/v1
    apiKey: YOUR_CODEX_PROXY_API_KEY
    roles:
      - chat
      - edit
      - apply

  - name: GPT-5.6 Terra
    provider: openai
    model: gpt-5.6-terra
    apiBase: https://spark-2209.tail921925.ts.net:8443/v1
    apiKey: YOUR_CODEX_PROXY_API_KEY
    roles:
      - chat
      - edit
      - apply
    requestOptions:
      extraBodyProperties:
        reasoning_effort: medium
```

Ganti `YOUR_CODEX_PROXY_API_KEY` dengan key proxy asli. Untuk menambah model,
salin blok kedua lalu ganti `name` dan `model` dengan ID dari tabel model.
`requestOptions.extraBodyProperties.reasoning_effort` bersifat opsional dan
dapat diisi `low`, `medium`, `high`, `xhigh`, atau `max` sesuai model.

Proxy belum mengirim OpenAI `tool_calls`, jadi jangan menambahkan capability
`tool_use`. Chat, Edit, dan Apply tetap dapat memakai respons teks, sedangkan
Agent mode Continue yang memerlukan tool calling belum didukung.

## Penggunaan dengan OpenAI SDK

### Python

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://spark-2209.tail921925.ts.net:8443/v1",
    api_key=os.environ["CODEX_PROXY_API_KEY"],
)

response = client.chat.completions.create(
    model="codex",
    messages=[
        {"role": "user", "content": "Jelaskan fungsi proyek ini."},
    ],
)

print(response.choices[0].message.content)
```

### JavaScript/TypeScript

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://spark-2209.tail921925.ts.net:8443/v1",
  apiKey: process.env.CODEX_PROXY_API_KEY,
});

const response = await client.chat.completions.create({
  model: "codex",
  messages: [
    { role: "user", content: "Jelaskan fungsi proyek ini." },
  ],
});

console.log(response.choices[0].message.content);
```

## API yang didukung

| Method | Path | Autentikasi | Fungsi |
| --- | --- | --- | --- |
| `GET` | `/health` | Tidak | Memeriksa apakah proxy hidup |
| `GET` | `/v1/models` | Ya | Mengambil alias model yang diiklankan proxy |
| `POST` | `/v1/chat/completions` | Ya | Mengirim chat completion |

Field permintaan yang digunakan:

| Field | Status | Keterangan |
| --- | --- | --- |
| `model` | Wajib | `codex` atau ID model eksplisit |
| `messages` | Wajib | Array pesan dengan role `system`, `user`, atau `assistant` |
| `stream` | Opsional | Aktifkan SSE dengan nilai `true` |
| `user` | Opsional | Kunci sesi untuk melanjutkan thread Codex |
| `reasoning_effort` | Opsional | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, atau `max`; alias `light` dan `extra-high` juga diterima |
| `temperature` | Diabaikan | Tidak diteruskan ke Codex CLI |
| `top_p` | Diabaikan | Tidak diteruskan ke Codex CLI |
| `max_tokens` | Diabaikan | Tidak diteruskan ke Codex CLI |
| `frequency_penalty` | Diabaikan | Tidak diteruskan ke Codex CLI |
| `presence_penalty` | Diabaikan | Tidak diteruskan ke Codex CLI |

Content yang didukung adalah teks biasa serta blok `text` atau `input_text`.
Gambar, audio, embeddings, Responses API, structured outputs, dan tool calls
belum didukung oleh proxy ini.

## Ruang kerja dan izin Codex

Codex CLI dijalankan pada komputer server, bukan pada perangkat klien. Ruang
kerjanya ditentukan oleh `CODEX_WORKING_DIR`; pada deployment saat ini service
berjalan dari direktori repositori proxy.

Sandbox default adalah `read-only`. Codex dapat membaca file dalam ruang kerja
yang diizinkan, tetapi tidak dapat mengubah file. Perubahan izin sandbox harus
dilakukan oleh pengelola server setelah mempertimbangkan siapa saja yang dapat
mengakses endpoint.

## Kode status dan pemecahan masalah

### `401 Invalid or missing API key`

Penyebab umum:

- Header `Authorization` tidak dikirim.
- Nilai masih berupa placeholder `API_KEY_ANDA`.
- Ada spasi, tanda kutip, atau baris baru yang ikut tersalin.
- Pengelola server sudah merotasi key.

Format header yang benar:

```text
Authorization: Bearer <key-asli>
```

### `401 Incorrect API key provided` dari `api.openai.com`

Pastikan server menggunakan versi terbaru dan environment proxy bernama
`CODEX_PROXY_API_KEY`. Jangan menggunakan nama `CODEX_API_KEY`, karena nama
tersebut dapat dibaca oleh Codex sebagai kredensial providernya.

### DNS atau koneksi gagal

Periksa:

```bash
tailscale status
tailscale ping spark-2209
curl -v https://spark-2209.tail921925.ts.net:8443/health
```

Pastikan perangkat klien berada dalam tailnet yang benar dan server online.

### `404 Not Found`

Gunakan path lengkap `/v1/chat/completions`. Jangan mengirim permintaan chat ke
base URL saja.

### `500 server_error`

Error ini biasanya berasal dari Codex CLI, misalnya model tidak tersedia,
autentikasi Codex server bermasalah, proses gagal, atau permintaan melewati
batas waktu. Kirim pesan error lengkap dan waktu kejadian kepada pengelola.

### Model tidak muncul di VS Code

1. Pastikan JSON valid dan tidak memiliki koma berlebih.
2. Jalankan **Developer: Reload Window**.
3. Buka **Chat: Manage Language Models** dan pastikan model tidak disembunyikan.
4. Ingat bahwa model dengan `toolCalling: false` tidak tersedia pada mode agent
   yang mensyaratkan tool calling.

## Operasional untuk pengelola server

Memeriksa service:

```bash
systemctl --user status codex-api-proxy.service
curl http://127.0.0.1:3456/health
```

Menampilkan API key saat ini untuk dipindahkan melalui kanal rahasia:

```bash
sed -n 's/^CODEX_PROXY_API_KEY=//p' ~/.config/codex-api-proxy/env
```

Melihat log:

```bash
journalctl --user -u codex-api-proxy.service -n 100 --no-pager
journalctl --user -u codex-api-proxy.service -f
```

Restart service:

```bash
systemctl --user restart codex-api-proxy.service
```

Memeriksa Tailscale Serve:

```bash
tailscale serve status
```

Mapping yang benar harus menunjukkan port `8443` sebagai `tailnet only` dan
target `http://127.0.0.1:3456`.

Menonaktifkan endpoint tailnet:

```bash
tailscale serve --https=8443 off
```

### Rotasi API key

Pada komputer server:

```bash
umask 077
printf 'CODEX_PROXY_API_KEY=%s\n' "$(openssl rand -hex 32)" \
  > ~/.config/codex-api-proxy/env
systemctl --user restart codex-api-proxy.service
```

Setelah rotasi, distribusikan key baru melalui password manager atau kanal
rahasia. Semua konfigurasi klien dengan key lama akan menerima HTTP `401`.

## Keamanan dan aturan penggunaan

- Jangan mengaktifkan Tailscale Funnel untuk port `8443`; Funnel membuat
  layanan dapat diakses dari internet publik.
- Jangan membagikan API key kepada orang yang tidak berwenang.
- Jangan menaruh API key dalam Git, dokumentasi publik, atau source code.
- Setiap permintaan menggunakan kuota akun Codex pada server.
- Prompt dan respons diproses melalui komputer server dan layanan OpenAI.
- Gunakan `user` yang unik agar konteks percakapan antar pengguna tidak
  tercampur.
- Hindari mengirim rahasia proyek jika penerima endpoint atau kebijakan proyek
  tidak mengizinkannya.
- Laporkan key yang bocor agar pengelola segera melakukan rotasi.

## Batasan penting

Proxy ini memberikan kompatibilitas Chat Completions untuk teks. Proxy ini
bukan pengganti penuh protokol Codex CLI, Codex app-server, atau ekstensi Codex.
Kemampuan seperti persetujuan interaktif, tool calls yang dikendalikan klien,
input gambar, sinkronisasi file perangkat klien, dan kontrol sandbox per
permintaan belum tersedia.

Untuk chat, gunakan endpoint ini. Untuk pengalaman penuh yang dapat membaca dan
mengedit repository, gunakan Codex langsung pada perangkat tempat repository
berada atau buka repository server melalui VS Code Remote SSH di atas
Tailscale.

## Referensi

- Model Codex: <https://developers.openai.com/codex/models>
- Model OpenAI: <https://developers.openai.com/api/docs/models>
- Codex IDE extension: <https://developers.openai.com/codex/ide>
- Custom Endpoint VS Code: <https://code.visualstudio.com/docs/agent-customization/language-models>
- Tailscale Serve: <https://tailscale.com/docs/reference/tailscale-cli/serve>
- Tailscale SSH: <https://tailscale.com/docs/features/tailscale-ssh>
