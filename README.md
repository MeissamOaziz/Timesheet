# ⏱ PunchClock Pro

A fully functional employee time clock web app — no server, no backend, no database required. Runs entirely in the browser using `localStorage`. Perfect for a tablet mounted at an office entrance connected to WiFi.

---

## 🚀 Deploy to GitHub Pages (5 minutes)

1. **Create a new GitHub repository** (e.g. `punchclock`)
2. Upload `index.html` to the root of the repo
3. Go to **Settings → Pages** → set source to `Deploy from a branch` → select `main` → `/ (root)` → Save
4. Your app will be live at: `https://YOUR-USERNAME.github.io/punchclock/`

---

## 📱 Features

### Clock In/Out (`/` main page)
- Dropdown grouped by company to select employee
- Large green **IN** and red **OUT** buttons
- Real-time clock display
- Prevents double punch-in or double punch-out

### Admin Authentication
- `/login` — Sign in with email + password
- `/register` — Register with name + email + password
- Email verification via 6-digit code (simulated in demo; production-ready with a backend email service)

### Admin Panel
- Add, edit, deactivate, or delete employees
- Assign employees to companies and departments
- View all registered admins and their status

### Companies
- Create and manage multiple companies
- Each employee belongs to a company
- Reports and admin panel support filtering by company

### Reports
- Filter by: custom range, week, bi-weekly, month, quarter, 6 months, or year
- Select individual employees or use Select All / Deselect All
- Summary stats: total records, total hours, employee count, average hours
- **Download in:** Excel (`.xlsx`), CSV (`.csv`), or PDF

### Activity Log
- Live view of all punch records (most recent first)
- Today's punch count and totals

---

## 💾 Data Storage

All data is stored in the browser's `localStorage` on the tablet. This means:
- ✅ Works offline after first load
- ✅ No server or database needed
- ✅ Data persists across browser sessions
- ⚠️ Data is device-specific — clearing browser storage will erase data
- ⚠️ Reports must be exported regularly to preserve historical records

**Recommended:** Export reports to Excel/CSV weekly and save to a shared drive.

---

## 🔐 Admin Notes

- First admin registers via the Register page
- The verification code is displayed on screen (in production, integrate with an email API like SendGrid or Resend)
- All admins can access all companies and all data

---

## 🛠 Customization

Since it's a single HTML file, everything is editable:
- Change the color scheme via CSS variables at the top (`:root { ... }`)
- Add your company logo to the nav
- Modify the default seed data to your own companies and employees
- Integrate real email sending by adding a small backend (Node.js + Express + Nodemailer is ~20 lines)

---

## 📦 Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML + CSS + JavaScript |
| Storage | Browser localStorage |
| Excel export | [SheetJS (xlsx)](https://sheetjs.com/) |
| PDF export | [jsPDF](https://github.com/parallax/jsPDF) + autotable |
| Fonts | Google Fonts (DM Sans + DM Mono) |
| Hosting | GitHub Pages (free) |

---

## 🗺 Upgrade Path

When you're ready to scale up:
1. Replace `localStorage` with a real database (PostgreSQL, Supabase, Firebase)
2. Add a backend (Node/Express or Next.js) for real email confirmation
3. Add PIN-based employee authentication for extra security
4. Add shift scheduling and overtime alerts

---

Made with ❤️ — single file, zero dependencies, works anywhere.
