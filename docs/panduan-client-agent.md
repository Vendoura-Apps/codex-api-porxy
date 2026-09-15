# Panduan Client Codex Agent melalui Tailscale

Panduan ini digunakan pada laptop atau PC rekan yang menyimpan repository
proyek. Codex dan login ChatGPT tetap berada di server `spark-2209`. Perangkat
klien hanya membutuhkan Tailscale, editor yang mendukung function tools, dan
API key proxy dari pengelola server.

## Informasi endpoint

| Pengaturan | Nilai |
| --- | --- |
| Base URL | `https://spark-2209.tail921925.ts.net:8443/v1` |
| Chat Completions URL | `https://spark-2209.tail921925.ts.net:8443/v1/chat/completions` |
| Health URL | `https://spark-2209.tail921925.ts.net:8443/health` |
| Provider | OpenAI-compatible |
| API type | Chat Completions |
| Model awal yang disarankan | `codex` |

API key proxy berbeda dari OpenAI API key. Jangan memasukkan key OpenAI atau
token login Codex pada perangkat klien.

## 1. Hubungkan perangkat ke Tailscale

1. Instal Tailscale dari <https://tailscale.com/download>.
2. Login dengan akun yang sudah diberi akses ke tailnet server.
3. Pastikan perangkat `spark-2209` terlihat dan online.
4. Jalankan pemeriksaan berikut dari terminal:

```bash
tailscale ping spark-2209
curl --fail --silent --show-error \
  https://spark-2209.tail921925.ts.net:8443/health
```

Respons health yang benar berisi `"status":"ok"`.

## 2. Simpan API key proxy

Minta API key kepada pengelola server melalui kanal pribadi. Jangan memakai
teks placeholder secara harfiah.

Linux atau macOS:

```bash
export CODEX_PROXY_API_KEY='PASTE_KEY_ASLI_DI_SINI'
```

Windows PowerShell:

```powershell
$env:CODEX_PROXY_API_KEY = "PASTE_KEY_ASLI_DI_SINI"
```

Variabel di atas hanya berlaku untuk terminal saat ini. Jangan menyimpan key di
repository, commit Git, issue, atau pesan grup.

## 3. Uji chat dari terminal

Linux atau macOS:

```bash
curl --fail --silent --show-error \
  https://spark-2209.tail921925.ts.net:8443/v1/chat/completions \
  -H "Authorization: Bearer $CODEX_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex",
    "reasoning_effort": "medium",
    "messages": [
      {"role": "user", "content": "Balas dengan CLIENT-OK"}
    ]
  }'
```

Windows PowerShell:

```powershell
curl.exe --fail --silent --show-error `
  "https://spark-2209.tail921925.ts.net:8443/v1/chat/completions" `
  -H "Authorization: Bearer $env:CODEX_PROXY_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"model":"codex","messages":[{"role":"user","content":"Balas dengan CLIENT-OK"}]}'
```

Jika respons memiliki `choices[0].message.content`, koneksi dan API key sudah
benar. Tes `curl` hanya menguji chat; akses repository memerlukan Agent mode di
editor.

## 4. Gunakan sebagai coding agent di Continue

1. Instal ekstensi Continue di VS Code pada perangkat klien.
2. Buka folder repository yang ingin dikerjakan melalui **File > Open Folder**.
3. Buka konfigurasi Continue dan tambahkan model berikut.
4. Ganti `YOUR_CODEX_PROXY_API_KEY` dengan API key proxy asli.
5. Reload VS Code, buka Continue, pilih **Agent mode**, lalu pilih **Codex
   Tailscale**.

```yaml
name: Codex Tailscale
version: 1.0.0
schema: v1

models:
  - name: Codex Tailscale
    provider: openai
    model: codex
    apiBase: https://spark-2209.tail921925.ts.net:8443/v1
    apiKey: YOUR_CODEX_PROXY_API_KEY
    roles:
      - chat
      - edit
      - apply
    capabilities:
      - tool_use
    requestOptions:
      extraBodyProperties:
        reasoning_effort: medium
        ponytail: full
```

`capabilities: [tool_use]` harus aktif agar Continue mengirim daftar tool ke
proxy. Tanpa bagian itu, request menjadi chat biasa dan model tidak dapat
menjelajah repository klien.

Untuk menguji agent, gunakan prompt:

```text
Baca package.json pada workspace ini menggunakan tool, jelaskan fungsi proyek,
dan jangan mengubah file apa pun.
```

Continue seharusnya menampilkan aktivitas tool lokal. Hasil pembacaan file
dikirim ke Codex melalui proxy, lalu jawaban kembali ke Continue.

Hapus baris `ponytail: full` atau ubah menjadi `ponytail: off` untuk mematikan
profil Ponytail. Pilihan lainnya adalah `lite` dan `ultra`.

## 5. Gunakan di Chat bawaan VS Code

Jalankan **Chat: Manage Language Models**, pilih **Add Models**, lalu pilih
**Custom Endpoint** dan API type **Chat Completions**. Jika perlu mengedit
`chatLanguageModels.json` secara manual, gunakan konfigurasi berikut:

```json
[
  {
    "name": "Codex Tailscale",
    "vendor": "customendpoint",
    "apiKey": "PASTE_KEY_ASLI_DI_SINI",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "codex@ponytail-off",
        "name": "Codex Tailscale (Ponytail Off)",
        "url": "https://spark-2209.tail921925.ts.net:8443/v1/chat/completions",
        "toolCalling": true,
        "vision": true,
        "streaming": true,
        "thinking": true,
        "supportsReasoningEffort": ["low", "medium", "high", "xhigh", "max"],
        "reasoningEffortFormat": "chat-completions",
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      },
      {
        "id": "codex@ponytail-full",
        "name": "Codex + Ponytail Full",
        "url": "https://spark-2209.tail921925.ts.net:8443/v1/chat/completions",
        "toolCalling": true,
        "vision": true,
        "streaming": true,
        "thinking": true,
        "supportsReasoningEffort": ["low", "medium", "high", "xhigh", "max"],
        "reasoningEffortFormat": "chat-completions",
        "maxInputTokens": 128000,
        "maxOutputTokens": 16000
      }
    ]
  }
]
```

Setelah menyimpan, jalankan **Developer: Reload Window**, buka folder proyek,
pilih model **Codex Tailscale**, kemudian gunakan Agent mode. Dukungan tool dari
Custom Endpoint dapat berbeda menurut versi VS Code. Jika Chat bekerja tetapi
Agent mode tidak mengirim tool, gunakan Continue dengan konfigurasi pada bagian
sebelumnya.

Di pemilih model, **Codex Tailscale (Ponytail Off)** mematikan Ponytail,
sedangkan **Codex + Ponytail Full** selalu mengaktifkan Ponytail `full`.

## 6. Cara menggunakan Agent mode dengan aman

1. Buka hanya folder proyek yang memang boleh diakses agent.
2. Mulai dengan permintaan baca saja, misalnya meminta ringkasan struktur
   repository.
3. Periksa nama tool, path, dan command yang muncul sebelum menyetujuinya.
4. Tolak command yang tidak dipahami atau mengarah keluar workspace.
5. Tinjau perubahan melalui panel Source Control atau `git diff` sebelum commit.

Perintah terminal dan perubahan file dijalankan oleh Continue atau VS Code pada
perangkat klien. Proxy tidak dapat menekan tombol persetujuan lokal. Pengaturan
approval pada editor menentukan apakah tool ditanyakan setiap kali atau dapat
berjalan otomatis.

## 7. Pilihan model dan reasoning effort

Model yang diiklankan endpoint:

| Model | Penggunaan singkat |
| --- | --- |
| `codex` | Mengikuti model default akun Codex server; pilihan awal terbaik |
| `codex@ponytail-off` | Model default dengan Ponytail dipaksa nonaktif |
| `codex@ponytail-lite` | Model default dengan profil Ponytail ringan |
| `codex@ponytail-full` | Model default dengan profil Ponytail penuh |
| `codex@ponytail-ultra` | Model default dengan pembatasan scope paling ketat |
| `gpt-6-astra` | Tugas coding dan penalaran paling sulit |
| `gpt-5.6-sol` | Pekerjaan kompleks berkualitas tinggi |
| `gpt-5.6` | Alias keluarga GPT-5.6 |
| `gpt-5.6-terra` | Pekerjaan harian yang seimbang |
| `gpt-5.6-luna` | Tugas cepat dan berulang |
| `gpt-5.5` | Kompatibilitas generasi sebelumnya |
| `gpt-5.3-codex-spark` | Iterasi coding berlatensi rendah jika akun mendukung |

Tidak semua model selalu tersedia untuk akun server. Gunakan `codex` jika model
eksplisit menghasilkan error.

Nilai reasoning effort yang umum adalah `low`, `medium`, `high`, `xhigh`, dan
`max`. Alias `light` dipetakan ke `low`, sedangkan `extra-high` dipetakan ke
`xhigh`. Tingkat yang lebih tinggi biasanya membutuhkan waktu dan kuota lebih
banyak.

Ponytail mengatur gaya kerja coding dan terpisah dari reasoning effort. Mode
`off`, `lite`, `full`, atau `ultra` dapat dikirim melalui field `ponytail`.
Panduan lengkap tersedia di [Mode Ponytail opsional](ponytail.md).

## 8. Pemecahan masalah

### Health berhasil tetapi request mendapat `401`

API key kosong, masih berupa placeholder, salah salin, atau sudah dirotasi.
Minta key terbaru kepada pengelola dan pastikan header berbentuk:

```text
Authorization: Bearer <key-asli>
```

### Tailscale tidak menemukan server

Pastikan login ke tailnet yang benar, lalu jalankan:

```bash
tailscale status
tailscale ping spark-2209
```

### Chat berhasil tetapi agent tidak membaca file

- Pastikan folder proyek sudah dibuka sebagai workspace pada perangkat klien.
- Pilih Agent mode, bukan Chat mode biasa.
- Pada Continue, pastikan capability `tool_use` ada.
- Pada VS Code Custom Endpoint, pastikan `toolCalling` bernilai `true`.
- Mulai percakapan baru setelah mengubah konfigurasi atau reload editor.

### Model mencoba membaca repository proxy

Ini menandakan request dikirim tanpa function tools dan diproses sebagai chat
biasa. Aktifkan Agent mode serta `tool_use`, lalu mulai percakapan baru. Pada
request agent yang benar, operasi file dan terminal diarahkan ke tool perangkat
klien.

### `invalid_tool_call_id` atau tool call kedaluwarsa

Pending agent turn disimpan maksimal 15 menit dan hilang saat service restart.
Mulai percakapan atau task baru agar klien memperoleh `tool_call_id` baru.

### Model eksplisit gagal

Ganti nilai `model` menjadi `codex`. Ketersediaan model eksplisit mengikuti
paket, kebijakan, dan rollout akun Codex yang login pada server.

## Ringkasan arsitektur

```text
Repository dan terminal rekan
        ^             |
        | tool call   | hasil tool
        |             v
Continue / VS Code pada perangkat klien
        ^             |
        | HTTPS privat melalui Tailscale
        |             v
Codex API Proxy pada spark-2209
        ^             |
        | Codex App Server
        |             v
Layanan Codex memakai login dan kuota server
```

Login Codex tidak disalin ke klien. Walaupun demikian, prompt, potongan file,
hasil pencarian, dan output terminal yang diperlukan agent melewati proxy dan
diproses oleh layanan Codex. Semua pemakaian rekan menggunakan akun dan kuota
Codex pada server.

## Mengirim gambar dan file

Klien dapat mengirim PNG, JPEG, WebP, serta file teks UTF-8 melalui content
blocks. Aktifkan dukungan vision pada konfigurasi model dengan
`"vision": true`. URL gambar dari internet tidak diterima; klien harus membaca
file lokal dan mengirimkannya sebagai base64 data URL.

Contoh bentuk pesannya:

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "Analisis gambar dan catatan berikut"},
    {
      "type": "image_url",
      "image_url": {"url": "data:image/png;base64,<BASE64_PNG>", "detail": "auto"}
    },
    {
      "type": "input_file",
      "filename": "notes.md",
      "file_data": "data:text/markdown;base64,<BASE64_MARKDOWN>"
    }
  ]
}
```

Batas default adalah 10 attachment, 10 MiB hasil decode per attachment, dan 25
MiB hasil decode total. PDF dan `file_id` belum didukung. Kontrak lengkap untuk
implementasi VTI CLI atau extension tersedia di [Attachment contract](attachments.md).
