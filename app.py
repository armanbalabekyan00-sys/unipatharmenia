from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

from flask import Flask, abort, jsonify, redirect, render_template, request, send_from_directory, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("UNIPATH_DATA_DIR", str(ROOT / "data"))).expanduser()
DATABASE = Path(os.getenv("DATABASE_PATH", str(DATA_DIR / "unipath.sqlite3"))).expanduser()
CATALOG = json.loads((ROOT / "catalog.json").read_text(encoding="utf-8"))
DESTINATIONS = CATALOG["destinations"]
UNIVERSITIES = CATALOG["universities"]
PROGRAMS = CATALOG["programs"]
UNIVERSITY_BY_SLUG = {item["slug"]: item for item in UNIVERSITIES}
PROGRAM_BY_SLUG = {item["slug"]: item for item in PROGRAMS}
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
PUBLIC_URL = os.getenv("PUBLIC_URL", "").rstrip("/")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "unipath-demo-admin")

app = Flask(__name__, template_folder="templates", static_folder="static")
app.secret_key = os.getenv("APP_SECRET_KEY", "unipath-local-change-this-secret-before-deploying")
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("COOKIE_SECURE", "false").lower() == "true",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
)


SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS app_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS contact_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL,
  subject TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS contact_reply (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, reply TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(message_id) REFERENCES contact_message(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS demo_subscription (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, plan TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES app_user(id)
);
CREATE TABLE IF NOT EXISTS user_favorite (
  user_id INTEGER NOT NULL, university_slug TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, university_slug), FOREIGN KEY(user_id) REFERENCES app_user(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS student_profile (
  user_id INTEGER PRIMARY KEY, target_country TEXT DEFAULT '', intended_degree TEXT DEFAULT '',
  subject_area TEXT DEFAULT '', target_intake TEXT DEFAULT '', annual_budget TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES app_user(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS chat_conversation (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS chat_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, sender TEXT NOT NULL,
  message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(conversation_id) REFERENCES chat_conversation(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS password_reset_token (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, used_at TEXT,
  FOREIGN KEY(user_id) REFERENCES app_user(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS google_account (
  google_subject TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES app_user(id) ON DELETE CASCADE
);
"""


@contextmanager
def connect_db():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE, timeout=20)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db() -> None:
    with connect_db() as connection:
        connection.executescript(SCHEMA)


init_db()


def api_error(message: str, status: int):
    return jsonify(detail=message), status


def json_body() -> dict:
    return request.get_json(silent=True) or {}


def require_fields(data: dict, fields: list[str]) -> str | None:
    for field in fields:
        if not str(data.get(field, "")).strip():
            return f"{field} is required."
    return None


def valid_email(value: str) -> bool:
    return bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value or ""))


def current_user_id() -> int | None:
    try:
        return int(session["user_id"])
    except (KeyError, TypeError, ValueError):
        return None


def require_admin() -> bool:
    return bool(session.get("unipath_admin"))


def send_email(to: str, subject: str, body: str, reply_to: str | None = None) -> bool:
    host = os.getenv("SMTP_HOST", "").strip()
    if not host:
        return False
    message = EmailMessage()
    message["From"] = os.getenv("SMTP_FROM", os.getenv("SMTP_USERNAME", "unipath@localhost"))
    message["To"] = to
    message["Subject"] = subject.replace("\r", " ").replace("\n", " ")
    if reply_to:
        message["Reply-To"] = reply_to
    message.set_content(body)
    port = int(os.getenv("SMTP_PORT", "587"))
    username = os.getenv("SMTP_USERNAME", "")
    password = os.getenv("SMTP_PASSWORD", "")
    try:
        if os.getenv("SMTP_STARTTLS", "true").lower() == "true":
            with smtplib.SMTP(host, port, timeout=15) as server:
                server.starttls(context=ssl.create_default_context())
                if os.getenv("SMTP_AUTH", "true").lower() == "true" and username:
                    server.login(username, password)
                server.send_message(message)
        else:
            with smtplib.SMTP_SSL(host, port, timeout=15, context=ssl.create_default_context()) as server:
                if username:
                    server.login(username, password)
                server.send_message(message)
        return True
    except Exception:
        app.logger.exception("Could not send configured SMTP email")
        return False


@app.context_processor
def shared_template_data():
    path = request.path
    base = PUBLIC_URL or request.url_root.rstrip("/")
    is_en = path == "/en" or path.startswith("/en/")
    is_hy = not is_en and not path.startswith(("/api/", "/static/", "/images/", "/css/", "/js/", "/robots.txt", "/sitemap.xml"))
    english_path = path[3:] if is_en else path
    if not english_path:
        english_path = "/"
    hy_path = english_path
    english_page_url = base + ("/en/" if english_path == "/" else "/en" + english_path)
    return {
        "destinations": DESTINATIONS,
        "destinationCount": len(DESTINATIONS),
        "universityCount": len(UNIVERSITIES),
        "programExampleCount": len(PROGRAMS),
        "logged_in": current_user_id() is not None,
        "googleLoginEnabled": bool(GOOGLE_CLIENT_ID),
        "googleClientId": GOOGLE_CLIENT_ID,
        "is_hy": is_hy,
        "page_language": "hy" if is_hy else "en",
        "english_url": english_page_url,
        "armenian_url": base + hy_path,
        "private_page": english_path in {"/login", "/register", "/account", "/admin", "/checkout", "/forgot-password", "/reset-password"},
        "canonical_url": base + path,
        "format_number": lambda value: f"{int(value):,}",
        "hy_country": lambda value: {"United States": "ԱՄՆ", "United Kingdom": "Միացյալ Թագավորություն", "United Arab Emirates": "Արաբական Միացյալ Էմիրություններ", "South Korea": "Հարավային Կորեա", "Germany": "Գերմանիա", "Italy": "Իտալիա", "France": "Ֆրանսիա", "Spain": "Իսպանիա", "Canada": "Կանադա", "Australia": "Ավստրալիա", "Ireland": "Իռլանդիա", "China": "Չինաստան", "Scotland": "Շոտլանդիա", "Netherlands": "Նիդերլանդներ", "Singapore": "Սինգապուր", "Austria": "Ավստրիա", "Belgium": "Բելգիա", "Czech Republic": "Չեխիա", "Poland": "Լեհաստան", "Portugal": "Պորտուգալիա", "Sweden": "Շվեդիա", "Switzerland": "Շվեյցարիա"}.get(value, value),
        "hy_degree": lambda value: {"Bachelor's": "Բակալավրիատ", "Master's": "Մագիստրատուրա", "PhD": "Ասպիրանտուրա", "Doctorate": "Դոկտորական"}.get(value, value),
        "hy_field": lambda value: {"Computer science": "Համակարգչային գիտություն", "Business": "Բիզնես", "Engineering": "Ճարտարագիտություն", "Arts & humanities": "Արվեստ և հումանիտար գիտություններ", "Medicine": "Բժշկություն"}.get(value, value),
        "hy_mode": lambda value: {"Full-time": "Առկա", "Part-time": "Հեռակա", "Online": "Առցանց"}.get(value, value),
        "hy_duration": lambda value: str(value).replace(" years", " տարի").replace(" year", " տարի"),
        "hy_tag": lambda value: {"algorithms": "ալգորիթմներ", "analytics": "վերլուծություն", "behavior": "վարքագիծ", "climate": "կլիմա", "cognition": "ճանաչողություն", "communication": "հաղորդակցություն", "design": "նախագծում", "diplomacy": "դիվանագիտություն", "ecology": "էկոլոգիա", "energy": "էներգետիկա", "epidemiology": "համաճարակաբանություն", "finance": "ֆինանսներ", "global affairs": "գլոբալ հարցեր", "health systems": "առողջապահական համակարգեր", "international": "միջազգային", "leadership": "առաջնորդություն", "legal systems": "իրավական համակարգեր", "machine learning": "մեքենայական ուսուցում", "markets": "շուկաներ", "materials": "նյութեր", "policy": "քաղաքականություն", "research": "հետազոտություն", "software": "ծրագրային ապահովում", "statistics": "վիճակագրություն", "strategy": "ռազմավարություն", "studio": "ստուդիա", "sustainability": "կայուն զարգացում", "systems": "համակարգեր", "urbanism": "քաղաքաշինություն"}.get(value, value),
    }


def page(template: str, *, title: str, description: str, active: str = "", **context):
    if not (request.path == "/en" or request.path.startswith("/en/")) and not request.path.startswith(("/api/", "/static/", "/images/", "/css/", "/js/", "/robots.txt", "/sitemap.xml")):
        hy_titles = {
            "index.html": "Սովորել արտերկրում․ համալսարաններ և ընդունելություն",
            "universities.html": "Համալսարաններ և ծրագրեր արտերկրում",
            "program.html": "Ուսումնական ծրագիր արտերկրում",
            "about.html": "UniPath-ի մասին",
            "services.html": "Աջակցություն արտերկրում ուսման դիմելու համար",
            "contact.html": "Կապվել UniPath-ի հետ",
            "login.html": "Մուտք գործել UniPath",
            "register.html": "Ստեղծել UniPath հաշիվ",
            "account.html": "Ձեր UniPath հաշիվը",
            "admin.html": "UniPath-ի ադմինիստրացիա",
            "checkout.html": "Ամրագրել խորհրդատվություն UniPath-ի հետ",
            "forgot-password.html": "Վերականգնել UniPath-ի գաղտնաբառը",
            "reset-password.html": "Սահմանել նոր գաղտնաբառ",
        }
        hy_descriptions = {
            "index.html": "Համեմատեք արտասահմանյան համալսարաններն ու ուսումնական ծրագրերը, ուսումնասիրեք ուսման վարձը և ընդունելության պահանջները։ Առաջին հանդիպումն անվճար է։",
            "universities.html": "Փնտրեք արտասահմանյան համալսարաններ ու ծրագրեր՝ ըստ երկրի, մասնագիտության, աստիճանի, ուսման վարձի և կրթաթոշակների։",
            "about.html": "Իմացեք UniPath-ի և արտասահմանում սովորելու պլանավորման աջակցության մասին։",
            "services.html": "Ծանոթացեք համալսարան ընտրելու, դիմումը պլանավորելու և կրթաթոշակներ ուսումնասիրելու UniPath ծառայություններին։ Առաջին հանդիպումն անվճար է։",
            "contact.html": "Կապվեք UniPath-ի հետ արտասահմանյան համալսարանների և ընդունելության գործընթացի վերաբերյալ հարցերով։",
        }
        title = hy_titles.get(template, title)
        description = hy_descriptions.get(template, description)
        template = "hy/" + template
    return render_template(template, page_title=title, page_description=description, active=active, **context)


@app.after_request
def security_headers(response):
    if request.path.startswith("/en/") and response.mimetype == "text/html":
        response.direct_passthrough = False
        body = response.get_data(as_text=True)
        body = re.sub(
            r'((?:href|action)=[\'\"])(/(?:home|universities|programs(?:/[^\'\"?#]*)?|about|services|how-it-works|pricing|checkout|contact|login|register|forgot-password|reset-password|account|admin)(?:[?#][^\'\"]*)?)([\'\"])',
            lambda match: match.group(1) + "/en" + match.group(2) + match.group(3),
            body,
        )
        body = body.replace('href="/"', 'href="/en/"').replace("href='/'", "href='/en/'")
        response.set_data(body)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    return response


@app.get("/images/<path:filename>")
def images(filename):
    return send_from_directory(ROOT / "static" / "images", filename)


@app.get("/css/<path:filename>")
def css_files(filename):
    return send_from_directory(ROOT / "static" / "css", filename)


@app.get("/js/<path:filename>")
def js_files(filename):
    return send_from_directory(ROOT / "static" / "js", filename)


@app.get("/")
@app.get("/home")
def home():
    return page("index.html", title="Study abroad universities and admissions", description="Explore international universities, compare study abroad programs, tuition and entry requirements across popular destinations with UniPath.", active="home")


@app.get("/universities")
def universities_page():
    country = request.args.get("country", "all") or "all"
    query = request.args.get("q", "").strip()
    degree = request.args.get("degree", "")
    field = request.args.get("field", "")
    mode = request.args.get("mode", "all")
    min_fee = request.args.get("minFee", type=int)
    max_fee = request.args.get("maxFee", type=int)
    scholarship = request.args.get("scholarship", "false").lower() in {"true", "on", "1"}
    sort = request.args.get("sort", "relevance")
    page_number = request.args.get("page", 1, type=int) or 1
    results = []
    needle = query.lower()
    for program in PROGRAMS:
        search_text = " ".join(str(program[key]) for key in ("title", "degree", "field", "university", "country", "city", "tags")).lower()
        if country not in {"", "all"} and program["countrySlug"] != country:
            continue
        if needle and needle not in search_text:
            continue
        if degree and program["degree"] != degree:
            continue
        if field and program["field"].lower() != field.lower():
            continue
        if mode != "all" and program["mode"] != mode:
            continue
        if min_fee is not None and program["annualTuitionUsd"] < max(0, min_fee):
            continue
        if max_fee is not None and program["annualTuitionUsd"] > max(0, max_fee):
            continue
        if scholarship and not program["scholarship"]:
            continue
        results.append(program)
    if sort == "name":
        results.sort(key=lambda item: (item["university"].lower(), item["title"].lower()))
    elif sort == "tuition-low":
        results.sort(key=lambda item: item["annualTuitionUsd"])
    elif sort == "tuition-high":
        results.sort(key=lambda item: item["annualTuitionUsd"], reverse=True)
    per_page = 12
    page_count = max(1, (len(results) + per_page - 1) // per_page)
    page_number = min(max(1, page_number), page_count)
    current_programs = results[(page_number - 1) * per_page:page_number * per_page]
    params = request.args.to_dict()
    def page_link(number):
        updated = dict(params)
        if number <= 1:
            updated.pop("page", None)
        else:
            updated["page"] = str(number)
        route = "/en/universities" if request.path.startswith("/en/") else "/universities"
        return route + "?" + urllib.parse.urlencode(updated) if updated else route
    country_name = next((item["name"] for item in DESTINATIONS if item["slug"] == country), None)
    hy_country_names = {"United States": "ԱՄՆ", "United Kingdom": "Միացյալ Թագավորություն", "United Arab Emirates": "Արաբական Միացյալ Էմիրություններ", "South Korea": "Հարավային Կորեա", "Germany": "Գերմանիա", "Italy": "Իտալիա", "France": "Ֆրանսիա", "Spain": "Իսպանիա", "Canada": "Կանադա", "Australia": "Ավստրալիա", "Ireland": "Իռլանդիա", "China": "Չինաստան", "Scotland": "Շոտլանդիա"}
    is_hy = not request.path.startswith("/en/")
    title_country = hy_country_names.get(country_name, country_name) if is_hy else country_name
    title = ("Արտասահմանյան ծրագրեր և համալսարաններ" if is_hy else "Study abroad programs and universities") if not country_name else (f"Ծրագրեր և համալսարաններ՝ {title_country}-ում" if is_hy else f"Study abroad programs in {country_name}")
    description = (("Որոնեք արտասահմանյան ծրագրեր՝ ըստ համալսարանի, երկրի, աստիճանի, ոլորտի, ուսման վարձի և կրթաթոշակների։" if is_hy else "Search study abroad programs by university, country, degree, field, tuition and funding. Compare examples across 22 destinations.") if not country_name else (f"Համեմատեք {title_country}-ի ծրագրերը, համալսարանները, աստիճաններն ու ուսման վարձի մոտավոր չափերը։ Ընդունելության պահանջները ճշտեք համալսարանից։" if is_hy else f"Compare study abroad programs, universities, degree options and tuition estimates in {country_name}. Check current entry requirements with each university."))
    context = dict(
        programs=current_programs, programCount=len(results), pageCount=page_count, currentPage=page_number,
        previousPageUrl=page_link(page_number - 1) if page_number > 1 else None,
        nextPageUrl=page_link(page_number + 1) if page_number < page_count else None,
        query=query, selectedCountry=country, selectedDegree=degree,
        bachelorSelected=degree == "Bachelor's", masterSelected=degree == "Master's",
        selectedField=field, selectedMode=mode, minFee=min_fee, maxFee=max_fee,
        scholarshipOnly=scholarship, selectedSort=sort,
    )
    return page("universities.html", title=title, description=description, active="universities", **context)


@app.get("/programs/<slug>")
def program_page(slug):
    program = PROGRAM_BY_SLUG.get(slug)
    if not program:
        abort(404)
    return page("program.html", title=f"{program['degree']} {program['title']} at {program['university']}", description=f"Explore the {program['title']} {program['degree']} program at {program['university']} in {program['city']}, {program['country']}. Review study details and confirm admissions information with the university.", active="universities", program=program)


@app.get("/about")
def about_page():
    return page("about.html", title="About UniPath", description="Learn about UniPath, its study-abroad planning services and international study destinations.", active="about")


@app.get("/admin")
def admin_page():
    return page("admin.html", title="UniPath team admin", description="Private UniPath administration area.")


@app.get("/services")
@app.get("/how-it-works")
@app.get("/pricing")
def services_page():
    return page("services.html", title="Study abroad application support", description="Explore international university shortlist, application guidance, essay feedback and admissions support with UniPath.", active="services")


@app.get("/checkout")
def checkout_page():
    return page("checkout.html", title="Reserve your UniPath guidance", description="Request your selected study abroad guidance package. No payment is processed on this demo website.", private_page=True)


@app.get("/contact")
def contact_page():
    return page("contact.html", title="Contact UniPath", description="Contact UniPath about universities abroad, application guidance, or a free first consultation.", active="contact")


@app.get("/login")
def login_page():
    return page("login.html", title="Log in to UniPath", description="Sign in to save international universities and continue your study abroad application plan.", private_page=True)


@app.get("/register")
def register_page():
    return page("register.html", title="Create a UniPath account", description="Create a free UniPath account to save overseas universities and organize your study shortlist.", private_page=True)


@app.get("/forgot-password")
def forgot_password_page():
    return page("forgot-password.html", title="Reset your UniPath password", description="Request a secure link to reset your UniPath password.", private_page=True)


@app.get("/reset-password")
def reset_password_page():
    return page("reset-password.html", title="Choose a new UniPath password", description="Set a new password for your UniPath account.", private_page=True, resetToken=request.args.get("token", ""))


@app.get("/account")
def account_page():
    if current_user_id() is None:
        return redirect(("/en/login" if request.path.startswith("/en/") else "/login") + "?next=account")
    return page("account.html", title="Your UniPath account", description="Manage your UniPath account, university shortlist and study plan.", private_page=True)


@app.get("/robots.txt")
def robots():
    base = PUBLIC_URL or request.url_root.rstrip("/")
    return f"User-agent: *\nAllow: /\nSitemap: {base}/sitemap.xml\n", 200, {"Content-Type": "text/plain; charset=utf-8"}


@app.get("/google299c26865c7a81e0.html")
def google_site_verification():
    return "google-site-verification: google299c26865c7a81e0.html", 200, {"Content-Type": "text/html; charset=utf-8"}


@app.get("/BingSiteAuth.xml")
def bing_site_verification():
    return "<users>\n<user>34B0E910628220E745E37DF5A84EF327</user>\n</users>", 200, {"Content-Type": "application/xml; charset=utf-8"}


@app.get("/sitemap.xml")
def sitemap():
    base = PUBLIC_URL or request.url_root.rstrip("/")
    armenian_urls = ["/", "/universities", "/services", "/about", "/contact"] + ["/programs/" + item["slug"] for item in PROGRAMS]
    english_urls = [("/en/" if path == "/" else "/en" + path) for path in armenian_urls]
    urls = armenian_urls + english_urls
    xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    xml += "".join(f"<url><loc>{base}{path}</loc></url>" for path in urls) + "</urlset>"
    return xml, 200, {"Content-Type": "application/xml; charset=utf-8"}


@app.post("/api/register")
def api_register():
    data = json_body()
    missing = require_fields(data, ["firstName", "lastName", "email", "password"])
    if missing:
        return api_error(missing, 400)
    first, last = str(data["firstName"]).strip(), str(data["lastName"]).strip()
    email, password = str(data["email"]).strip().lower(), str(data["password"])
    if len(first) > 55 or len(last) > 55 or len(email) > 254 or not valid_email(email):
        return api_error("Enter a valid name and email address.", 400)
    if len(password) < 8 or len(password.encode("utf-8")) > 72:
        return api_error("Choose a password between 8 and 72 bytes.", 400)
    try:
        with connect_db() as db:
            cursor = db.execute("INSERT INTO app_user(name,email,password_hash) VALUES(?,?,?)", (first + " " + last, email, generate_password_hash(password)))
            user_id = cursor.lastrowid
    except sqlite3.IntegrityError:
        return api_error("An account with this email already exists.", 409)
    session.clear(); session["user_id"] = user_id; session["user_name"] = first + " " + last; session["user_email"] = email; session.permanent = True
    return jsonify(name=session["user_name"], email=email), 201


@app.post("/api/login")
def api_login():
    data = json_body(); email = str(data.get("email", "")).strip().lower(); password = str(data.get("password", ""))
    if not email or not password:
        return api_error("Enter your email and password.", 400)
    with connect_db() as db:
        user = db.execute("SELECT id,name,email,password_hash FROM app_user WHERE email=?", (email,)).fetchone()
    if not user or not check_password_hash(user["password_hash"], password):
        return api_error("Email or password is incorrect.", 401)
    session.clear(); session["user_id"] = user["id"]; session["user_name"] = user["name"]; session["user_email"] = user["email"]; session.permanent = True
    return jsonify(name=user["name"], email=user["email"])


@app.post("/api/google-login")
def api_google_login():
    if not GOOGLE_CLIENT_ID:
        return api_error("Google sign-in has not been configured for this site.", 503)
    credential = str(json_body().get("credential", ""))
    try:
        from google.auth.transport import requests as google_requests
        from google.oauth2 import id_token
        claims = id_token.verify_oauth2_token(credential, google_requests.Request(), GOOGLE_CLIENT_ID)
        if not claims.get("email_verified"):
            return api_error("Google could not verify this sign-in. Please try again.", 401)
    except Exception:
        return api_error("Google could not verify this sign-in. Please try again.", 401)
    subject, email = claims["sub"], claims["email"].strip().lower()
    with connect_db() as db:
        linked = db.execute("SELECT u.* FROM google_account g JOIN app_user u ON u.id=g.user_id WHERE g.google_subject=?", (subject,)).fetchone()
        user = linked or db.execute("SELECT * FROM app_user WHERE email=?", (email,)).fetchone()
        if user is None:
            name = (claims.get("name") or email.split("@", 1)[0]).strip()
            cursor = db.execute("INSERT INTO app_user(name,email,password_hash) VALUES(?,?,?)", (name, email, generate_password_hash(secrets.token_urlsafe(32))))
            user = db.execute("SELECT * FROM app_user WHERE id=?", (cursor.lastrowid,)).fetchone()
        if not linked:
            prior = db.execute("SELECT 1 FROM google_account WHERE user_id=?", (user["id"],)).fetchone()
            if prior:
                return api_error("This UniPath account is linked to another Google account. Sign in with its original method.", 409)
            db.execute("INSERT INTO google_account(google_subject,user_id) VALUES(?,?)", (subject, user["id"]))
    session.clear(); session["user_id"] = user["id"]; session["user_name"] = user["name"]; session["user_email"] = user["email"]; session.permanent = True
    return jsonify(name=user["name"], email=user["email"])


@app.post("/api/password-reset/request")
def api_password_reset_request():
    if not os.getenv("SMTP_HOST", "").strip():
        return api_error("Password reset email is not configured. Please contact the UniPath team.", 503)
    email = str(json_body().get("email", "")).strip().lower()
    if not valid_email(email):
        return api_error("Enter a valid email address.", 400)
    with connect_db() as db:
        user = db.execute("SELECT id FROM app_user WHERE email=?", (email,)).fetchone()
        if user:
            token = secrets.token_urlsafe(32)
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            expires = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
            db.execute("DELETE FROM password_reset_token WHERE user_id=?", (user["id"],))
            db.execute("INSERT INTO password_reset_token(token_hash,user_id,expires_at) VALUES(?,?,?)", (token_hash, user["id"], expires))
            base = PUBLIC_URL or request.url_root.rstrip("/")
            sent = send_email(email, "Reset your UniPath password", f"Use this secure link within 30 minutes to choose a new password:\n\n{base}/reset-password?token={token}\n\nIf you did not request this, ignore this message.")
            if not sent:
                db.execute("DELETE FROM password_reset_token WHERE token_hash=?", (token_hash,))
                return api_error("The reset email could not be sent. Check SMTP settings and try again.", 502)
    return jsonify(message="If an account matches that address, we’ve sent a password reset link. Check your inbox.")


@app.post("/api/password-reset/confirm")
def api_password_reset_confirm():
    data = json_body(); token = str(data.get("token", "")); password = str(data.get("password", ""))
    if not token or len(password) < 8 or len(password.encode("utf-8")) > 72:
        return api_error("Use a valid reset link and a password between 8 and 72 bytes.", 400)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    now = datetime.now(timezone.utc)
    with connect_db() as db:
        row = db.execute("SELECT user_id,expires_at,used_at FROM password_reset_token WHERE token_hash=?", (token_hash,)).fetchone()
        if not row or row["used_at"] or datetime.fromisoformat(row["expires_at"]) < now:
            return api_error("That reset link has expired or was already used. Request a new link.", 400)
        db.execute("UPDATE app_user SET password_hash=? WHERE id=?", (generate_password_hash(password), row["user_id"]))
        db.execute("UPDATE password_reset_token SET used_at=? WHERE token_hash=?", (now.isoformat(), token_hash))
    return jsonify(message="Your password has been updated. You can sign in now.")


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify(message="You are signed out.")


@app.get("/api/me")
def api_me():
    user_id = current_user_id()
    if user_id is None:
        return api_error("Please sign in to view your account.", 401)
    with connect_db() as db:
        user = db.execute("SELECT name,email FROM app_user WHERE id=?", (user_id,)).fetchone()
        goals = db.execute("SELECT target_country,intended_degree,subject_area,target_intake,annual_budget FROM student_profile WHERE user_id=?", (user_id,)).fetchone()
        subscriptions = db.execute("SELECT plan,status,created_at FROM demo_subscription WHERE user_id=? ORDER BY created_at DESC", (user_id,)).fetchall()
        favorites = db.execute("SELECT COUNT(*) FROM user_favorite WHERE user_id=?", (user_id,)).fetchone()[0]
    if not user:
        session.clear(); return api_error("Please sign in to view your account.", 401)
    session["user_name"] = user["name"]; session["user_email"] = user["email"]
    return jsonify(name=user["name"], email=user["email"], goals=dict(goals) if goals else {}, subscriptions=[dict(item) for item in subscriptions], favoritesCount=favorites)


@app.post("/api/profile")
def api_profile():
    user_id = current_user_id()
    if user_id is None:
        return api_error("Please sign in to update your profile.", 401)
    data = json_body(); first = str(data.get("firstName", "")).strip(); last = str(data.get("lastName", "")).strip()
    if not first or not last or len(first) > 55 or len(last) > 55:
        return api_error("Enter your first and last name.", 400)
    name = first + " " + last
    with connect_db() as db:
        db.execute("UPDATE app_user SET name=? WHERE id=?", (name, user_id))
        db.execute("INSERT INTO student_profile(user_id,target_country,intended_degree,subject_area,target_intake,annual_budget) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET target_country=excluded.target_country,intended_degree=excluded.intended_degree,subject_area=excluded.subject_area,target_intake=excluded.target_intake,annual_budget=excluded.annual_budget,updated_at=CURRENT_TIMESTAMP", (user_id, str(data.get("targetCountry", ""))[:80], str(data.get("intendedDegree", ""))[:40], str(data.get("subjectArea", ""))[:80], str(data.get("targetIntake", ""))[:40], str(data.get("annualBudget", ""))[:40]))
    session["user_name"] = name
    return jsonify(name=name)


@app.route("/api/favorites", methods=["GET", "POST"])
def api_favorites():
    user_id = current_user_id()
    if user_id is None:
        return api_error("Please sign in to save universities.", 401)
    if request.method == "GET":
        with connect_db() as db:
            rows = db.execute("SELECT university_slug FROM user_favorite WHERE user_id=? ORDER BY created_at DESC", (user_id,)).fetchall()
        return jsonify([{"slug": row[0], "name": UNIVERSITY_BY_SLUG.get(row[0], {}).get("name", row[0])} for row in rows])
    data = json_body(); slug = str(data.get("slug", "")).lower(); action = str(data.get("action", "")).lower()
    if slug not in UNIVERSITY_BY_SLUG or action not in {"save", "remove"}:
        return api_error("Choose a university and an available action.", 400)
    with connect_db() as db:
        if action == "save":
            db.execute("INSERT OR IGNORE INTO user_favorite(user_id,university_slug) VALUES(?,?)", (user_id, slug))
        else:
            db.execute("DELETE FROM user_favorite WHERE user_id=? AND university_slug=?", (user_id, slug))
    return jsonify(slug=slug, name=UNIVERSITY_BY_SLUG[slug]["name"], saved=action == "save")


@app.post("/api/contact")
def api_contact():
    data = json_body(); missing = require_fields(data, ["name", "email", "subject", "message"])
    if missing:
        return api_error(missing, 400)
    name, email, subject, message = (str(data[key]).strip() for key in ("name", "email", "subject", "message"))
    if not valid_email(email) or len(name) > 120 or len(email) > 254 or len(subject) > 180 or not 10 <= len(message) <= 3000:
        return api_error("Check your email and message details, then try again.", 400)
    with connect_db() as db:
        db.execute("INSERT INTO contact_message(name,email,subject,message) VALUES(?,?,?,?)", (name, email.lower(), subject, message))
    recipient = os.getenv("CONTACT_RECIPIENT", "").strip()
    if recipient and os.getenv("SMTP_HOST", "").strip():
        sent = send_email(recipient, "UniPath contact: " + subject, f"From: {name} ({email})\n\n{message}", email)
        if not sent:
            return api_error("Your message was saved, but the email notification could not be sent.", 502)
        return jsonify(message="Your note is on its way. Our team will be in touch soon."), 201
    return jsonify(message="Your note was saved for the UniPath team. We’ll be in touch soon."), 201


@app.post("/api/purchase")
def api_purchase():
    data = json_body(); missing = require_fields(data, ["plan", "name", "email", "destination"])
    if missing:
        return api_error(missing, 400)
    plan = str(data["plan"]).lower(); email = str(data["email"]).strip().lower(); promo = str(data.get("promoCode", "")).strip().upper()
    if plan not in {"starter", "application", "essay", "full"}:
        return api_error("Choose a valid plan.", 400)
    if not valid_email(email):
        return api_error("Enter a valid email address.", 400)
    if promo not in {"", "STUDY10", "UNIPATH15"}:
        return api_error("That promo code is not valid.", 400)
    discount = {"STUDY10": 10, "UNIPATH15": 15}.get(promo, 0)
    name = str(data["name"]).strip(); destination = str(data["destination"]).strip()
    note = f"Destination: {destination}. Promo code: {promo or 'none'} ({discount}% discount requested). Booking request only; no payment was taken and card details were not collected."
    with connect_db() as db:
        db.execute("INSERT INTO contact_message(name,email,subject,message) VALUES(?,?,?,?)", (name, email, "Guidance booking: " + plan, note))
        if current_user_id() is not None:
            db.execute("INSERT INTO demo_subscription(user_id,plan,status) VALUES(?,?,?)", (current_user_id(), plan, "PENDING_CONTACT"))
    return jsonify(message=f"Congratulations! Your request for {plan} guidance is saved. We’ll contact you at {email} to confirm next steps. " + (f"Your {discount}% promo request is noted. " if discount else "") + "No money was taken."), 201


def chat_answer(question: str) -> str:
    value = question.lower()
    if "country" in value or "destination" in value:
        return "UniPath includes study destinations across Europe, North America, Asia, Oceania and the Middle East. Open Destinations or filter the program finder by country."
    if "scholarship" in value or "funding" in value:
        return "Funding rules differ by university and program. Turn on the scholarship filter to find example listings, then verify eligibility and deadlines on the official university site."
    if any(word in value for word in ("tuition", "cost", "fee")):
        return "The finder shows broad planning estimates in USD. They are not official quotes; check the university’s current tuition page and living-cost guidance before deciding."
    if any(word in value for word in ("apply", "application", "deadline")):
        return "Start with the university’s official course page for requirements and dates. UniPath’s application guidance can help you organize a shortlist, documents and timeline."
    if any(word in value for word in ("program", "course", "university")):
        return "Use the program finder’s search, country, degree, subject, tuition and scholarship filters. Save a university to build your shortlist."
    return "I can help you find programs, compare tuition estimates, understand funding filters or plan application steps. For advice about your own case, send a note from Contact us."


def clean_uuid(value: str) -> str | None:
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        return None


@app.route("/api/chat", methods=["GET", "POST"])
def api_chat():
    if request.method == "GET":
        conversation = clean_uuid(request.args.get("conversationId", ""))
        if not conversation:
            return api_error("That chat session is invalid.", 400)
        with connect_db() as db:
            rows = db.execute("SELECT sender,message,created_at FROM chat_entry WHERE conversation_id=? ORDER BY id", (conversation,)).fetchall()
        return jsonify([dict(row) for row in rows])
    data = json_body(); conversation = clean_uuid(str(data.get("conversationId", ""))); message = str(data.get("message", "")).strip()
    if not conversation or not message or len(message) > 1000:
        return api_error("Enter a message to send.", 400)
    answer = chat_answer(message)
    with connect_db() as db:
        db.execute("INSERT INTO chat_conversation(id,updated_at) VALUES(?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET updated_at=CURRENT_TIMESTAMP", (conversation,))
        db.execute("INSERT INTO chat_entry(conversation_id,sender,message) VALUES(?,?,?)", (conversation, "student", message))
        db.execute("INSERT INTO chat_entry(conversation_id,sender,message) VALUES(?,?,?)", (conversation, "assistant", answer))
    return jsonify(answer=answer)


@app.post("/api/admin/login")
def api_admin_login():
    if not ADMIN_PASSWORD:
        return api_error("Admin access is disabled until ADMIN_PASSWORD is configured.", 503)
    if not secrets.compare_digest(str(json_body().get("password", "")), ADMIN_PASSWORD):
        return api_error("That admin password is not correct.", 401)
    session["unipath_admin"] = True
    return jsonify(message="Admin access granted.")


def admin_guard():
    if not require_admin():
        return api_error("Admin sign-in is required.", 401)
    return None


@app.get("/api/admin/dashboard")
def api_admin_dashboard():
    denied = admin_guard()
    if denied:
        return denied
    with connect_db() as db:
        users = db.execute("SELECT COUNT(*) FROM app_user").fetchone()[0]
        saved = db.execute("SELECT COUNT(*) FROM user_favorite").fetchone()[0]
        inquiry_count = db.execute("SELECT COUNT(*) FROM contact_message").fetchone()[0]
        reply_count = db.execute("SELECT COUNT(*) FROM contact_reply").fetchone()[0]
        recent = db.execute("SELECT m.id,m.name,m.email,m.subject,m.message,m.created_at,(SELECT r.reply FROM contact_reply r WHERE r.message_id=m.id ORDER BY r.sent_at DESC LIMIT 1) AS latest_reply FROM contact_message m ORDER BY m.created_at DESC LIMIT 100").fetchall()
        user_rows = db.execute("SELECT u.name,u.email,u.created_at,COALESCE(p.target_country,'') AS target_country,COALESCE(p.intended_degree,'') AS intended_degree,COALESCE(p.subject_area,'') AS subject_area,COALESCE(p.target_intake,'') AS target_intake,COALESCE(p.annual_budget,'') AS annual_budget,(SELECT COUNT(*) FROM user_favorite f WHERE f.user_id=u.id) AS favorites FROM app_user u LEFT JOIN student_profile p ON p.user_id=u.id ORDER BY u.created_at DESC LIMIT 250").fetchall()
        chat_rows = db.execute("SELECT c.id,c.created_at,(SELECT e.message FROM chat_entry e WHERE e.conversation_id=c.id AND e.sender='student' ORDER BY e.id LIMIT 1) AS preview,(SELECT e.message FROM chat_entry e WHERE e.conversation_id=c.id ORDER BY e.id DESC LIMIT 1) AS latest,(SELECT COUNT(*) FROM chat_entry e WHERE e.conversation_id=c.id AND e.sender='student') AS student_messages FROM chat_conversation c ORDER BY c.updated_at DESC LIMIT 100").fetchall()
    return jsonify(users=users, savedUniversities=saved, inquiries=inquiry_count, replies=reply_count,
                   recentInquiries=[dict(row) for row in recent], usersList=[dict(row) for row in user_rows], chatThreads=[dict(row) for row in chat_rows])


@app.get("/api/admin/chat")
def api_admin_chat_history():
    denied = admin_guard()
    if denied:
        return denied
    conversation = clean_uuid(request.args.get("conversationId", ""))
    if not conversation:
        return api_error("That chat session is invalid.", 400)
    with connect_db() as db:
        rows = db.execute("SELECT sender,message,created_at FROM chat_entry WHERE conversation_id=? ORDER BY id", (conversation,)).fetchall()
    return jsonify([dict(row) for row in rows])


@app.post("/api/admin/chat/reply")
def api_admin_chat_reply():
    denied = admin_guard()
    if denied:
        return denied
    data = json_body(); conversation = clean_uuid(str(data.get("conversationId", ""))); message = str(data.get("message", "")).strip()
    if not conversation or not message or len(message) > 3000:
        return api_error("Enter a reply to send.", 400)
    with connect_db() as db:
        exists = db.execute("SELECT 1 FROM chat_conversation WHERE id=?", (conversation,)).fetchone()
        if not exists:
            return api_error("That chat conversation no longer exists.", 404)
        db.execute("INSERT INTO chat_entry(conversation_id,sender,message) VALUES(?,?,?)", (conversation, "team", message))
        db.execute("UPDATE chat_conversation SET updated_at=CURRENT_TIMESTAMP WHERE id=?", (conversation,))
    return jsonify(message="Reply added to the website chat.")


@app.post("/api/admin/reply")
def api_admin_reply():
    denied = admin_guard()
    if denied:
        return denied
    data = json_body(); message_id = data.get("messageId"); reply = str(data.get("message", "")).strip()
    if not reply or len(reply) > 3000:
        return api_error("Enter a reply.", 400)
    with connect_db() as db:
        inquiry = db.execute("SELECT email,subject FROM contact_message WHERE id=?", (message_id,)).fetchone()
        if not inquiry:
            return api_error("That enquiry no longer exists.", 404)
        if not send_email(inquiry["email"], "Re: " + inquiry["subject"], reply):
            return api_error("Email replies are not configured yet. Set SMTP settings or reply manually by email.", 503)
        db.execute("INSERT INTO contact_reply(message_id,reply) VALUES(?,?)", (message_id, reply))
    return jsonify(message="Reply sent and saved to this enquiry.")


@app.post("/api/admin/logout")
def api_admin_logout():
    session.pop("unipath_admin", None)
    return jsonify(message="Admin signed out.")


@app.post("/api/translate")
def api_translate():
    data = json_body(); text = str(data.get("q", "")); source = str(data.get("source", "en")); target = str(data.get("target", ""))
    if not text or len(text) > 450 or source not in {"en", "hy", "ru"} or target not in {"en", "hy", "ru"}:
        return api_error("Supported languages are English, Armenian and Russian.", 400)
    if source == target:
        return jsonify(translatedText=text)
    try:
        key = os.getenv("GOOGLE_TRANSLATE_API_KEY", "").strip()
        if key:
            payload = urllib.parse.urlencode({"q": text, "source": source, "target": target, "format": "text", "key": key}).encode()
            req = urllib.request.Request("https://translation.googleapis.com/language/translate/v2", data=payload, headers={"Content-Type": "application/x-www-form-urlencoded"})
            with urllib.request.urlopen(req, timeout=8) as response:
                translated = json.loads(response.read()).get("data", {}).get("translations", [{}])[0].get("translatedText")
        else:
            url = "https://api.mymemory.translated.net/get?" + urllib.parse.urlencode({"q": text, "langpair": source + "|" + target})
            with urllib.request.urlopen(url, timeout=8) as response:
                translated = json.loads(response.read()).get("responseData", {}).get("translatedText")
        if not translated:
            raise ValueError("empty translation")
        return jsonify(translatedText=translated)
    except Exception:
        return api_error("Translation service is temporarily unavailable. Please try again shortly.", 502)


@app.errorhandler(404)
def not_found(_error):
    if request.path.startswith("/api/"):
        return api_error("Not found.", 404)
    return "Page not found", 404


# Each Armenian page has its own stable URL and its own editable HTML template.
# The handlers reuse the same catalog and account logic as the English site.
for _english_path, _view_name in (
    ("/", "home"), ("/universities", "universities_page"),
    ("/programs/<slug>", "program_page"), ("/about", "about_page"),
    ("/admin", "admin_page"), ("/services", "services_page"),
    ("/checkout", "checkout_page"), ("/contact", "contact_page"),
    ("/login", "login_page"), ("/register", "register_page"),
    ("/forgot-password", "forgot_password_page"),
    ("/reset-password", "reset_password_page"), ("/account", "account_page"),
):
    _en_path = "/en/" if _english_path == "/" else "/en" + _english_path
    app.add_url_rule(_en_path, endpoint="en_" + _view_name, view_func=app.view_functions[_view_name], methods=["GET"])
app.add_url_rule("/en/how-it-works", endpoint="en_how_it_works", view_func=app.view_functions["services_page"], methods=["GET"])
app.add_url_rule("/en/pricing", endpoint="en_pricing", view_func=app.view_functions["services_page"], methods=["GET"])


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8080")), debug=os.getenv("FLASK_DEBUG", "false").lower() == "true")
