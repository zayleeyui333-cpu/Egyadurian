EGYA DURIAN ADMIN — PAKET PEMASANGAN AWAL
========================================

Paket ini menambahkan halaman admin terpisah, login pemilik, API server-side di Vercel, edit konten dasar, edit nama/harga 6 produk, edit 4 promo, edit 3 testimoni, serta upload banner utama/foto produk.

PENTING
- Token GitHub hanya digunakan di API server Vercel. Jangan pernah menaruh token di index.html, script.js, atau file yang dikirim ke browser.
- Jangan mengirim ADMIN_PASSWORD, SESSION_SECRET, atau GITHUB_TOKEN ke chat.
- Token GitHub yang tidak memiliki masa kedaluwarsa tetap berisiko jika bocor. Cabut token di GitHub jika diduga bocor.
- File index.html asli tidak diganti oleh paket ini. Paket hanya menambahkan file baru, kecuali jika bosku kemudian menggunakan admin untuk menyimpan konten.

CARA PASANG
1. Ekstrak isi ZIP ke folder repository lokal:
   C:\Heri lo ini\OBAT NGANTUK\durian\repo-github
   Pastikan opsi merge folder aktif jika diminta. Jangan ekstrak ke folder dur atau folder induk durian.

2. Pastikan hasil folder seperti ini:
   repo-github\admin.html
   repo-github\api\admin\login.js
   repo-github\api\admin\session.js
   repo-github\api\admin\logout.js
   repo-github\api\admin\content.js
   repo-github\api\admin\upload.js
   repo-github\lib\admin-auth.js
   repo-github\lib\github-repo.js

3. Di VS Code, buka folder repo-github. Pastikan ketiga Environment Variables berikut sudah ada di project Vercel Production:
   GITHUB_TOKEN
   ADMIN_PASSWORD
   SESSION_SECRET

4. Buka PowerShell di folder repo-github dan jalankan:
   git status
   Jika hanya file baru dari paket ini muncul di daftar perubahan, lanjutkan:
   git add admin.html api lib README-ID.txt
   git commit -m "Add EGYA DURIAN admin panel"
   git push origin main

5. Tunggu deployment Vercel terbaru bertanda Ready.

6. Buka halaman:
   https://egyadurian.vercel.app/admin.html
   Masukkan nilai ADMIN_PASSWORD yang disimpan di Vercel (tidak perlu mengirim nilainya ke siapa pun).

CARA PAKAI
- Kontak, hero, deskripsi, promo, nama/harga/badge produk, dan testimoni dapat disunting di panel.
- Tombol Simpan Perubahan membuat commit baru ke branch main; Vercel lalu menjalankan deployment otomatis.
- Upload gambar menerima JPG, PNG, WebP maksimal 2 MB. Gambar disimpan ke folder assets di GitHub dan referensinya di index.html diperbarui.
- Halaman Admin disembunyikan dari indeks mesin pencari, tetapi akses tetap dilindungi login dan API server-side.

PEMERIKSAAN AWAL
Setelah deployment Ready, login dan periksa isi form sebelum mengedit. Untuk percobaan pertama, ubah satu teks kecil, tekan Simpan Perubahan, kemudian cek deployment di Vercel dan website utama. Jangan tekan Simpan berulang kali ketika satu proses masih berjalan.

CATATAN
- Paket pertama ini mengedit konten/produk yang sudah ada. Menambah atau menghapus kartu produk dan mengelola semua galeri sekaligus belum tersedia di versi awal.
- GitHub menjadi sumber konten; tidak diperlukan database terpisah untuk versi ini.
