# Mode Ponytail opsional

Proxy menyediakan profil coding opsional yang terinspirasi oleh
[Ponytail](https://github.com/dietrichgebert/ponytail). Profil ini mendorong
agent membaca kode yang relevan, memakai ulang implementasi yang ada,
memilih fasilitas bawaan sebelum menambah dependency, dan membuat perubahan
terkecil yang tetap benar.

Implementasi proxy tidak memasang plugin atau lifecycle hook Ponytail pada
akun Codex server. Mode dipilih secara terpisah pada setiap request, sehingga
rekan A dapat memakai `full` sementara rekan B tetap memakai `off`.

## Pilihan mode

| Mode | Perilaku |
| --- | --- |
| `off` | Tidak menambahkan instruksi Ponytail |
| `lite` | Menyelesaikan permintaan dan menyebutkan opsi yang lebih sederhana bila memang berarti |
| `full` | Konsisten memilih reuse, fitur bawaan, dan perubahan kecil; pilihan umum yang disarankan |
| `ultra` | Sangat ketat terhadap scope spekulatif dan mencari peluang menghapus atau memakai ulang kode lebih dulu |

Semua mode tetap mempertahankan kebutuhan eksplisit, keamanan, validasi,
perlindungan data, aksesibilitas, dan error handling yang diperlukan.
`ultra` di sini adalah mode Ponytail dan berbeda dari `reasoning_effort`.

## Mengaktifkan per request

Kirim field `ponytail` bersama body Chat Completions:

```bash
curl --fail --silent --show-error \
  https://spark-2209.tail921925.ts.net:8443/v1/chat/completions \
  -H "Authorization: Bearer $CODEX_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex",
    "ponytail": "full",
    "messages": [
      {"role":"user","content":"Perbaiki bug ini dengan perubahan sekecil mungkin."}
    ]
  }'
```

Nilai yang diterima adalah `off`, `lite`, `full`, `ultra`, `true`, dan
`false`. Boolean `true` sama dengan `full`; `false` sama dengan `off`.

## Memilih melalui ID model

Klien yang tidak dapat menambah field request dapat memakai suffix model:

- `codex@ponytail-lite`
- `codex@ponytail-full`
- `codex@ponytail-ultra`
- `codex@ponytail-off` untuk memaksa profil tetap mati walaupun default server aktif

Suffix yang sama dapat dipakai pada model eksplisit, misalnya
`gpt-5.6-terra@ponytail-full`. Proxy melepas suffix sebelum memanggil Codex,
sehingga nama model yang diteruskan tetap `gpt-5.6-terra`.

Jika field `ponytail` dan suffix model dipakai bersama, field `ponytail`
mendapat prioritas. Contohnya, `"ponytail":"off"` mematikan profil walaupun
model bernama `codex@ponytail-ultra`.

## Continue

Continue dapat mengirim field tersebut melalui `extraBodyProperties`:

```yaml
models:
  - name: Codex Ponytail Full
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

Untuk membuat pilihan aktif/mati di daftar model, buat dua entri Continue:
satu memakai `model: codex@ponytail-off`, satu lagi memakai
`model: codex@ponytail-full`.

## Custom Endpoint VS Code

Tambahkan model normal dan model Ponytail ke array `models`:

```json
{
  "models": [
    {
      "id": "codex@ponytail-off",
      "name": "Codex (Ponytail Off)",
      "url": "https://spark-2209.tail921925.ts.net:8443/v1/chat/completions",
      "toolCalling": true,
      "vision": true
    },
    {
      "id": "codex@ponytail-full",
      "name": "Codex + Ponytail Full",
      "url": "https://spark-2209.tail921925.ts.net:8443/v1/chat/completions",
      "toolCalling": true,
      "vision": true
    }
  ]
}
```

Pilih **Codex (Ponytail Off)** untuk mematikan Ponytail atau **Codex + Ponytail
Full** untuk mengaktifkannya.

## Default pada server

Pengelola dapat menetapkan mode saat request tidak menentukan pilihan:

```bash
CODEX_PONYTAIL_DEFAULT=full npm start
```

Nilai default bawaan adalah `off`. Pada instalasi systemd, tambahkan ke file
environment service:

```text
CODEX_PONYTAIL_DEFAULT=full
```

Setelah mengubah environment, restart service. Klien tetap dapat menimpa
default dengan field `ponytail` atau suffix model.

## Attribution

Konsep mode dan prinsip implementasi terinspirasi oleh Ponytail karya Dietrich
Gebert, yang dirilis dengan lisensi MIT. Proxy memakai implementasi instruksi
ringkasnya sendiri dan tidak membundel kode hook Ponytail.
