# DISC Assessment App (Hapi.js)

Aplikasi tes DISC untuk seleksi:
- Server Specialist
- Beverage Specialist
- Senior Cook

## Fitur
- Form identitas kandidat (nama, email, WA aktif, role dipilih)
- Tes DISC 24 soal dengan timer 10 menit
- Auto-submit saat waktu habis
- Kandidat hanya bisa ikut tes 1 kali (berdasarkan email/WA)
- Simpan hasil ke SQLite database
- Rekomendasi role otomatis + alasan penilaian
- Dashboard HR (tabel kandidat + filter + grafik)
- Kelola bank soal DISC (tambah, edit, hapus, aktif/nonaktif)
- Profil detail kandidat
- Hapus hasil tes kandidat dari dashboard/profil HR
- Export Excel dan PDF

## Menjalankan
```bash
npm install
npm run dev
```

Atau mode normal:
```bash
npm start
```

Buka:
- Kandidat: `http://localhost:3000/`
- Login HR: `http://localhost:3000/hr/login`
- Dashboard HR (setelah login): `http://localhost:3000/hr/dashboard`

## Konfigurasi Security HR
Project ini otomatis membaca file `.env`.

Setup cepat:
```bash
cp .env.example .env
```

Isi value berikut:

- `HR_LOGIN_EMAIL` (contoh: `hr@company.com`)
- `HR_PASSWORD_HASH` (hash bcrypt, bukan plain password)
- `HR_JWT_SECRET` (minimal 32 karakter, wajib untuk production)
- `COOKIE_PASSWORD` (minimal 32 karakter, wajib untuk production)

Generate hash password HR:
```bash
npm run hr:hash-password -- "PasswordKuatAnda123!"
```

## Health Check Auth
Jalankan pengecekan otomatis proteksi/login HR:
```bash
npm run verify:health
```

Agar script juga menguji login sukses, isi salah satu:
- `HR_LOGIN_PASSWORD` di `.env`, atau
- argumen password saat run:
```bash
npm run verify:health -- "PasswordHRAnda"
```

## Catatan
- Soal diambil dari file `one_for_all_v1.txt`
- Database otomatis dibuat di `data/disc_app.db`
- Jika kandidat perlu retest, data kandidat sebelumnya bisa dihapus dari dashboard HR.
