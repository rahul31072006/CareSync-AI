"""CareSync AI backend core: auth, patient profiles, invites, medications, dose tracking, audit, email reminders."""
import json, logging, os, re, secrets, shutil, smtplib, ssl
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, date, time as dtime, timezone
from email.message import EmailMessage
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import jwt, JWTError
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr
from dotenv import load_dotenv
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Date, ForeignKey, Boolean, Float, Text, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from apscheduler.schedulers.background import BackgroundScheduler

load_dotenv()
APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
IS_PRODUCTION = APP_ENV == "production"
DB_URL = os.getenv("DATABASE_URL", "sqlite:///./caresync.db")
if DB_URL.startswith("postgres://"):
    DB_URL = "postgresql+psycopg://" + DB_URL[len("postgres://"):]
elif DB_URL.startswith("postgresql://"):
    DB_URL = "postgresql+psycopg://" + DB_URL[len("postgresql://"):]
configured_secret = os.getenv("SECRET_KEY", "")
if IS_PRODUCTION and (len(configured_secret) < 32 or "replace-with" in configured_secret.lower()):
    raise RuntimeError("Production requires a unique SECRET_KEY of at least 32 characters.")
if IS_PRODUCTION and DB_URL.startswith("sqlite"):
    raise RuntimeError("Production requires a persistent PostgreSQL DATABASE_URL.")
SECRET = configured_secret or secrets.token_urlsafe(32)
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "./private_uploads"))
if IS_PRODUCTION and not UPLOAD_DIR.is_absolute():
    raise RuntimeError("Production UPLOAD_DIR must be an absolute path on persistent storage.")
engine = create_engine(DB_URL, connect_args={"check_same_thread": False} if DB_URL.startswith("sqlite") else {},
                       pool_pre_ping=True)
Session_ = sessionmaker(bind=engine)
Base = declarative_base()
pwd = CryptContext(schemes=["bcrypt"])
oauth = OAuth2PasswordBearer(tokenUrl="/auth/login")
def now(): return datetime.now(timezone.utc).replace(tzinfo=None)

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True); email = Column(String, unique=True, index=True)
    name = Column(String); password_hash = Column(String)
class Patient(Base):
    __tablename__ = "patients"
    id = Column(Integer, primary_key=True); owner_id = Column(ForeignKey("users.id")); name = Column(String)
class Member(Base):  # access grant; patient controls role + permissions
    __tablename__ = "members"
    id = Column(Integer, primary_key=True); patient_id = Column(ForeignKey("patients.id")); user_id = Column(ForeignKey("users.id"))
    role = Column(String)  # patient | family | caretaker
    can_confirm_doses = Column(Boolean, default=False); can_edit_meds = Column(Boolean, default=False)
    can_manage_appointments = Column(Boolean, default=False); can_manage_routines = Column(Boolean, default=False)
    can_write_notes = Column(Boolean, default=False)
class Invite(Base):
    __tablename__ = "invites"
    id = Column(Integer, primary_key=True); patient_id = Column(ForeignKey("patients.id")); code = Column(String, unique=True)
    role = Column(String); expires_at = Column(DateTime); revoked = Column(Boolean, default=False); used = Column(Boolean, default=False)
class Medication(Base):
    __tablename__ = "medications"
    id = Column(Integer, primary_key=True); patient_id = Column(ForeignKey("patients.id")); name = Column(String)
    dosage = Column(String); frequency = Column(String); instructions = Column(Text, default="")
    start_date = Column(Date); end_date = Column(Date, nullable=True); times = Column(String)  # "08:00,20:00"
class DoseLog(Base):  # no row = unconfirmed. 'missed' is never auto-assigned.
    __tablename__ = "dose_logs"
    id = Column(Integer, primary_key=True); medication_id = Column(ForeignKey("medications.id")); scheduled_for = Column(DateTime)
    status = Column(String)  # taken | skipped | not_taken
    actor_id = Column(ForeignKey("users.id")); recorded_at = Column(DateTime, default=now)
class Audit(Base):
    __tablename__ = "audit"
    id = Column(Integer, primary_key=True); patient_id = Column(Integer); actor_id = Column(Integer)
    action = Column(String); at = Column(DateTime, default=now)
class Notification(Base):  # delivery log; status is 'sent' only after SMTP succeeds
    __tablename__ = "notifications"
    id = Column(Integer, primary_key=True); user_id = Column(Integer); key = Column(String, unique=True)
    message = Column(Text); status = Column(String); at = Column(DateTime, default=now)
class Appointment(Base):
    __tablename__ = "appointments"
    id = Column(Integer, primary_key=True); patient_id = Column(ForeignKey("patients.id"), index=True)
    doctor = Column(String); specialty = Column(String, default=""); hospital = Column(String, default="")
    starts_at = Column(DateTime); purpose = Column(String); notes = Column(Text, default="")
    reminder_minutes = Column(Integer, default=60); status = Column(String, default="scheduled")
class Routine(Base):
    __tablename__ = "routines"
    id = Column(Integer, primary_key=True); patient_id = Column(ForeignKey("patients.id"), index=True)
    name = Column(String); instructions = Column(Text, default=""); times = Column(String, default="")
    active = Column(Boolean, default=True)
class RoutineLog(Base):
    __tablename__ = "routine_logs"
    id = Column(Integer, primary_key=True); routine_id = Column(ForeignKey("routines.id"), index=True)
    scheduled_for = Column(DateTime); actor_id = Column(ForeignKey("users.id")); status = Column(String)
    recorded_at = Column(DateTime, default=now)
class CareNote(Base):
    __tablename__ = "care_notes"
    id = Column(Integer, primary_key=True); patient_id = Column(ForeignKey("patients.id"), index=True)
    author_id = Column(ForeignKey("users.id")); body = Column(Text); created_at = Column(DateTime, default=now)
class Handover(Base):
    __tablename__ = "handovers"
    id = Column(Integer, primary_key=True); patient_id = Column(ForeignKey("patients.id"), index=True)
    author_id = Column(ForeignKey("users.id")); from_label = Column(String); to_label = Column(String)
    summary = Column(Text); pending_tasks = Column(Text, default=""); created_at = Column(DateTime, default=now)
class CareTask(Base):
    __tablename__ = "care_tasks"
    id = Column(Integer, primary_key=True); patient_id = Column(ForeignKey("patients.id"), index=True)
    assignee_id = Column(ForeignKey("users.id")); assigned_by = Column(ForeignKey("users.id"))
    title = Column(String); due_at = Column(DateTime, nullable=True); status = Column(String, default="pending")
    created_at = Column(DateTime, default=now); completed_at = Column(DateTime, nullable=True)
class Prescription(Base):
    __tablename__ = "prescriptions"
    id = Column(Integer, primary_key=True); patient_id = Column(ForeignKey("patients.id"), index=True)
    uploaded_by = Column(ForeignKey("users.id")); filename = Column(String); content_type = Column(String)
    storage_path = Column(String); extracted_text = Column(Text, default="")
    extracted_fields = Column(Text, default="{}"); status = Column(String, default="pending_review")
    analysis_status = Column(String, default="not_analyzed"); analysis_result = Column(Text, default="[]")
    ocr_confidence = Column(Float, nullable=True)
    reviewer_id = Column(ForeignKey("users.id"), nullable=True); uploaded_at = Column(DateTime, default=now)
class CareSettings(Base):
    __tablename__ = "care_settings"
    patient_id = Column(ForeignKey("patients.id"), primary_key=True)
    initial_minutes = Column(Integer, default=5); followup_minutes = Column(Integer, default=30)
    escalation_minutes = Column(Integer, default=45); notify_caretakers = Column(Boolean, default=True)
    notify_family = Column(Boolean, default=True)
Base.metadata.create_all(engine)
member_columns = {column["name"] for column in inspect(engine).get_columns("members")}
boolean_default = "0" if engine.dialect.name == "sqlite" else "FALSE"
with engine.begin() as connection:
    for column in ("can_manage_appointments", "can_manage_routines", "can_write_notes"):
        if column not in member_columns:
            connection.execute(text(f"ALTER TABLE members ADD COLUMN {column} BOOLEAN DEFAULT {boolean_default}"))
prescription_columns = {column["name"] for column in inspect(engine).get_columns("prescriptions")}
with engine.begin() as connection:
    for column, definition in (("analysis_status", "VARCHAR DEFAULT 'not_analyzed'"),
                               ("analysis_result", "TEXT DEFAULT '[]'"),
                               ("ocr_confidence", "FLOAT")):
        if column not in prescription_columns:
            connection.execute(text(f"ALTER TABLE prescriptions ADD COLUMN {column} {definition}"))
    connection.execute(text("UPDATE prescriptions SET status = 'pending_review', reviewer_id = NULL WHERE status = 'verified'"))

@asynccontextmanager
async def lifespan(_: FastAPI):
    scheduler = None
    if os.getenv("DISABLE_SCHEDULER") != "1":
        scheduler = BackgroundScheduler()
        scheduler.add_job(remind_job, "interval", minutes=1)
        scheduler.start()
    try:
        yield
    finally:
        if scheduler: scheduler.shutdown(wait=False)

raw_cors = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
cors_origins = [origin.strip().rstrip("/") for origin in raw_cors.split(",") if origin.strip()]
if IS_PRODUCTION and (not cors_origins or any(not origin.startswith("https://") or "*" in origin for origin in cors_origins)):
    raise RuntimeError("Production CORS_ORIGINS must contain only explicit HTTPS frontend origins.")
app = FastAPI(title="CareSync AI", lifespan=lifespan,
              docs_url=None if IS_PRODUCTION else "/docs",
              redoc_url=None if IS_PRODUCTION else "/redoc",
              openapi_url=None if IS_PRODUCTION else "/openapi.json")
app.add_middleware(CORSMiddleware, allow_origins=cors_origins,
                   allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                   allow_headers=["Authorization", "Content-Type"], allow_credentials=True)
logger = logging.getLogger("caresync")

@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    if IS_PRODUCTION: response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response

@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    logger.info("Request validation failed for %s", request.url.path)
    return JSONResponse(status_code=422, content={"detail": "Request validation failed"})

@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, exc: Exception):
    logger.exception("Unhandled server error for %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})

def db():
    s = Session_()
    try: yield s
    finally: s.close()

@app.get("/health")
def health(s: Session = Depends(db)):
    s.execute(text("SELECT 1"))
    return {"status": "ok"}

def me(tok: str = Depends(oauth), s: Session = Depends(db)) -> User:
    try: uid = int(jwt.decode(tok, SECRET, algorithms=["HS256"])["sub"])
    except (JWTError, KeyError, ValueError): raise HTTPException(401, "Invalid token")
    u = s.get(User, uid)
    if not u: raise HTTPException(401, "Unknown user")
    return u
def access(s: Session, user: User, pid: int, need: str | None = None) -> Member:
    m = s.query(Member).filter_by(patient_id=pid, user_id=user.id).first()
    if not m: raise HTTPException(404, "Patient not found")  # isolation: no existence leak
    if m.role != "patient" and need and not getattr(m, need): raise HTTPException(403, "Permission not granted by patient")
    return m
def audit(s, pid, uid, action): s.add(Audit(patient_id=pid, actor_id=uid, action=action)); s.commit()

class Reg(BaseModel): email: EmailStr; name: str | None = None; password: str
@app.post("/auth/register")
def register(r: Reg, s: Session = Depends(db)):
    if len(r.password) < 8: raise HTTPException(422, "Password must be at least 8 characters")
    if s.query(User).filter_by(email=r.email).first(): raise HTTPException(409, "Email already registered")
    display_name = (r.name or r.email.split("@", 1)[0]).strip()
    s.add(User(email=r.email, name=display_name, password_hash=pwd.hash(r.password))); s.commit(); return {"ok": True}
FAILS: dict = {}
@app.post("/auth/login")
def login(f: OAuth2PasswordRequestForm = Depends(), s: Session = Depends(db)):
    recent = [t for t in FAILS.get(f.username, []) if t > now() - timedelta(minutes=10)]
    if len(recent) >= 5: raise HTTPException(429, "Too many attempts; try later")
    u = s.query(User).filter_by(email=f.username).first()
    if not u or not pwd.verify(f.password, u.password_hash):
        FAILS[f.username] = recent + [now()]; raise HTTPException(401, "Bad credentials")
    return {"access_token": jwt.encode({"sub": str(u.id), "exp": now() + timedelta(hours=8)}, SECRET, "HS256"), "token_type": "bearer"}

@app.post("/patients")
def create_patient(name: str, u: User = Depends(me), s: Session = Depends(db)):
    p = Patient(owner_id=u.id, name=name); s.add(p); s.commit()
    s.add(Member(patient_id=p.id, user_id=u.id, role="patient", can_confirm_doses=True, can_edit_meds=True)); s.commit()
    audit(s, p.id, u.id, "patient_created"); return {"id": p.id, "name": p.name}
@app.get("/patients")
def my_patients(u: User = Depends(me), s: Session = Depends(db)):
    return [{"id": p.id, "name": p.name, "role": m.role} for m, p in
            s.query(Member, Patient).join(Patient, Patient.id == Member.patient_id).filter(Member.user_id == u.id)]

@app.post("/patients/{pid}/invites")
def make_invite(pid: int, role: str, hours: int = 48, u: User = Depends(me), s: Session = Depends(db)):
    if access(s, u, pid).role != "patient": raise HTTPException(403, "Only the patient can invite")
    if role not in ("family", "caretaker"): raise HTTPException(422, "Role must be family or caretaker")
    if not 1 <= hours <= 168: raise HTTPException(422, "Invitation expiration must be between 1 and 168 hours")
    i = Invite(patient_id=pid, code=secrets.token_urlsafe(8), role=role, expires_at=now() + timedelta(hours=hours))
    s.add(i); s.commit(); audit(s, pid, u.id, f"invite_created:{role}"); return {"code": i.code, "expires_at": i.expires_at}
@app.delete("/patients/{pid}/invites/{code}")
def revoke_invite(pid: int, code: str, u: User = Depends(me), s: Session = Depends(db)):
    if access(s, u, pid).role != "patient": raise HTTPException(403, "Only the patient can revoke")
    i = s.query(Invite).filter_by(patient_id=pid, code=code).first()
    if not i: raise HTTPException(404, "Not found")
    i.revoked = True; s.commit(); audit(s, pid, u.id, "invite_revoked"); return {"ok": True}
@app.post("/invites/{code}/accept")
def accept(code: str, u: User = Depends(me), s: Session = Depends(db)):
    i = s.query(Invite).filter_by(code=code).first()
    if not i or i.revoked or i.used or i.expires_at < now(): raise HTTPException(400, "Invalid, used, revoked or expired code")
    if s.query(Member).filter_by(patient_id=i.patient_id, user_id=u.id).first(): raise HTTPException(409, "Already a member of this care profile")
    # least privilege by default; patient grants more via /members endpoint
    s.add(Member(patient_id=i.patient_id, user_id=u.id, role=i.role)); i.used = True; s.commit()
    audit(s, i.patient_id, u.id, "invite_accepted"); return {"patient_id": i.patient_id}
@app.get("/patients/{pid}/members")
def list_members(pid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid)
    rows = s.query(Member, User).join(User, User.id == Member.user_id).filter(Member.patient_id == pid).all()
    return [{"user_id": m.user_id, "name": member.name, "email": member.email, "role": m.role,
             "can_confirm_doses": m.can_confirm_doses, "can_edit_meds": m.can_edit_meds,
             "can_manage_appointments": m.can_manage_appointments, "can_manage_routines": m.can_manage_routines,
             "can_write_notes": m.can_write_notes} for m, member in rows]
@app.patch("/patients/{pid}/members/{uid}")
def set_perms(pid: int, uid: int, can_confirm_doses: bool | None = None, can_edit_meds: bool | None = None,
              can_manage_appointments: bool | None = None, can_manage_routines: bool | None = None,
              can_write_notes: bool | None = None, u: User = Depends(me), s: Session = Depends(db)):
    if access(s, u, pid).role != "patient": raise HTTPException(403, "Only the patient controls permissions")
    m = s.query(Member).filter_by(patient_id=pid, user_id=uid).first()
    if not m: raise HTTPException(404, "Not found")
    changes = {"can_confirm_doses": can_confirm_doses, "can_edit_meds": can_edit_meds,
               "can_manage_appointments": can_manage_appointments, "can_manage_routines": can_manage_routines,
               "can_write_notes": can_write_notes}
    for key, value in changes.items():
        if value is not None: setattr(m, key, value)
    s.commit()
    audit(s, pid, u.id, f"permissions_changed:{uid}"); return {"ok": True}
@app.delete("/patients/{pid}/members/{uid}")
def remove_member(pid: int, uid: int, u: User = Depends(me), s: Session = Depends(db)):
    if access(s, u, pid).role != "patient": raise HTTPException(403, "Only the patient can remove access")
    s.query(Member).filter_by(patient_id=pid, user_id=uid).filter(Member.role != "patient").delete(); s.commit()
    audit(s, pid, u.id, f"member_removed:{uid}"); return {"ok": True}

class MedIn(BaseModel):
    name: str; dosage: str; frequency: str; instructions: str = ""; start_date: date; end_date: date | None = None; times: list[str]
def med_out(m): return {"id": m.id, "name": m.name, "dosage": m.dosage, "frequency": m.frequency, "instructions": m.instructions,
                        "start_date": m.start_date, "end_date": m.end_date, "times": m.times.split(",")}
def check_times(ts):
    try: [dtime.fromisoformat(t) for t in ts]
    except ValueError: raise HTTPException(422, "Times must be HH:MM")
@app.post("/patients/{pid}/medications")
def add_med(pid: int, b: MedIn, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_edit_meds"); check_times(b.times)
    m = Medication(patient_id=pid, **b.model_dump(exclude={"times"}), times=",".join(b.times)); s.add(m); s.commit()
    audit(s, pid, u.id, f"medication_added:{m.name}"); return med_out(m)
@app.get("/patients/{pid}/medications")
def list_meds(pid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid); return [med_out(m) for m in s.query(Medication).filter_by(patient_id=pid)]
@app.put("/patients/{pid}/medications/{mid}")
def edit_med(pid: int, mid: int, b: MedIn, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_edit_meds"); check_times(b.times)
    m = s.query(Medication).filter_by(id=mid, patient_id=pid).first()
    if not m: raise HTTPException(404, "Not found")
    for k, v in b.model_dump(exclude={"times"}).items(): setattr(m, k, v)
    m.times = ",".join(b.times); s.commit(); audit(s, pid, u.id, f"medication_edited:{m.name}"); return med_out(m)
@app.delete("/patients/{pid}/medications/{mid}")
def del_med(pid: int, mid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_edit_meds")
    medication = s.query(Medication).filter_by(id=mid, patient_id=pid).first()
    if not medication: raise HTTPException(404, "Not found")
    s.query(DoseLog).filter_by(medication_id=mid).delete(); s.query(Medication).filter_by(id=mid, patient_id=pid).delete(); s.commit()
    audit(s, pid, u.id, f"medication_deleted:{mid}"); return {"ok": True}

def doses_for(s, pid, day: date):
    out = []
    for m in s.query(Medication).filter_by(patient_id=pid):
        if m.start_date <= day and (not m.end_date or day <= m.end_date):
            for t in m.times.split(","):
                at = datetime.combine(day, dtime.fromisoformat(t))
                log = s.query(DoseLog).filter_by(medication_id=m.id, scheduled_for=at).first()
                out.append({"medication_id": m.id, "name": m.name, "dosage": m.dosage, "scheduled_for": at,
                            "status": log.status if log else "unconfirmed",
                            "confirmed_by": log.actor_id if log else None, "recorded_at": log.recorded_at if log else None})
    return sorted(out, key=lambda d: d["scheduled_for"])
@app.get("/patients/{pid}/doses")
def today(pid: int, day: date | None = None, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid); return doses_for(s, pid, day or date.today())
class Confirm(BaseModel): medication_id: int; scheduled_for: datetime; status: str
@app.post("/patients/{pid}/doses/confirm")
def confirm(pid: int, b: Confirm, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_confirm_doses")
    if b.status not in ("taken", "skipped", "not_taken"): raise HTTPException(422, "Invalid status")
    medication = s.query(Medication).filter_by(id=b.medication_id, patient_id=pid).first()
    if not medication: raise HTTPException(404, "Not found")
    scheduled = b.scheduled_for
    if scheduled.tzinfo: scheduled = scheduled.astimezone(timezone.utc).replace(tzinfo=None)
    scheduled_time = scheduled.time().replace(second=0, microsecond=0)
    if scheduled.date() < medication.start_date or (medication.end_date and scheduled.date() > medication.end_date) or scheduled_time not in [dtime.fromisoformat(raw) for raw in medication.times.split(",")]:
        raise HTTPException(422, "This time is not a scheduled dose for the medication")
    log = s.query(DoseLog).filter_by(medication_id=b.medication_id, scheduled_for=scheduled).first() or DoseLog(medication_id=b.medication_id, scheduled_for=scheduled)
    log.status, log.actor_id, log.recorded_at = b.status, u.id, now(); s.add(log); s.commit()
    audit(s, pid, u.id, f"dose_{b.status}:{b.medication_id}"); return {"ok": True}
@app.get("/patients/{pid}/adherence")
def adherence(pid: int, days: int = 7, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid); res = []
    for i in range(days):
        d = doses_for(s, pid, date.today() - timedelta(days=i))
        c = {k: sum(x["status"] == k for x in d) for k in ("taken", "skipped", "not_taken", "unconfirmed")}
        res.append({"date": date.today() - timedelta(days=i), "total": len(d), **c})
    return res
@app.get("/patients/{pid}/audit")
def audit_log(pid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid)
    return [{"actor_id": a.actor_id, "action": a.action, "at": a.at} for a in s.query(Audit).filter_by(patient_id=pid).order_by(Audit.id.desc()).limit(200)]

def send_email(to, subject, body) -> str:
    host = os.getenv("SMTP_HOST")
    if not host: return "not_sent_smtp_not_configured"
    try:
        msg = EmailMessage(); msg["To"], msg["Subject"], msg["From"] = to, subject, os.getenv("SMTP_FROM", os.getenv("SMTP_USER", ""))
        msg.set_content(body)
        with smtplib.SMTP(host, int(os.getenv("SMTP_PORT", 587)), timeout=15) as c:
            c.starttls(context=ssl.create_default_context())
            if os.getenv("SMTP_USER"): c.login(os.getenv("SMTP_USER"), os.getenv("SMTP_PASSWORD", ""))
            c.send_message(msg)
        return "sent"
    except Exception as e: return f"failed:{type(e).__name__}"
def deliver_notification(s, user, key, subject, message):
    if s.query(Notification).filter_by(key=key).first(): return
    s.add(Notification(user_id=user.id, key=key, message=message,
                       status=send_email(user.email, subject, message)))
    s.commit()
def remind_job():
    """Send configured reminders once per dose stage; an unconfirmed dose remains unconfirmed."""
    s = Session_()
    try:
        t = now()
        for p in s.query(Patient):
            settings = s.get(CareSettings, p.id) or CareSettings(patient_id=p.id, initial_minutes=5,
                followup_minutes=30, escalation_minutes=45, notify_caretakers=True, notify_family=True)
            owner = s.get(User, p.owner_id)
            for d in doses_for(s, p.id, date.today()):
                if d["status"] != "unconfirmed": continue
                due = d["scheduled_for"]
                identity = f"{p.id}:{d['medication_id']}:{due:%Y%m%d%H%M}"
                msg = f"CareSync reminder: {d['name']} ({d['dosage']}) was scheduled for {due:%H:%M}. Please record its status; it is not assumed missed."
                if owner and t <= due <= t + timedelta(minutes=settings.initial_minutes):
                    deliver_notification(s, owner, f"dose:{identity}:initial:{owner.id}", "Medicine reminder", msg)
                elapsed = (t - due).total_seconds() / 60
                if owner and elapsed >= settings.followup_minutes:
                    deliver_notification(s, owner, f"dose:{identity}:followup:{owner.id}", "Dose confirmation needed", msg)
                if elapsed >= settings.escalation_minutes:
                    recipients = s.query(Member, User).join(User, User.id == Member.user_id).filter(
                        Member.patient_id == p.id, Member.role == "caretaker").all()
                    if settings.notify_caretakers:
                        for member, recipient in recipients:
                            deliver_notification(s, recipient, f"dose:{identity}:caretaker:{recipient.id}", "Caregiver dose follow-up", msg)
                if elapsed >= settings.escalation_minutes * 2 and settings.notify_family:
                    recipients = s.query(Member, User).join(User, User.id == Member.user_id).filter(
                        Member.patient_id == p.id, Member.role == "family").all()
                    for member, recipient in recipients:
                        deliver_notification(s, recipient, f"dose:{identity}:family:{recipient.id}", "Family care update", msg)
            for item in s.query(Appointment).filter_by(patient_id=p.id, status="scheduled"):
                send_at = item.starts_at - timedelta(minutes=item.reminder_minutes)
                if owner and t <= send_at < t + timedelta(minutes=1):
                    message = f"Upcoming appointment with {item.doctor} at {item.starts_at:%Y-%m-%d %H:%M}."
                    deliver_notification(s, owner, f"appointment:{item.id}:{owner.id}", "Appointment reminder", message)
    finally: s.close()
@app.get("/notifications")
def notes(u: User = Depends(me), s: Session = Depends(db)):
    return [{"message": n.message, "status": n.status, "at": n.at} for n in s.query(Notification).filter_by(user_id=u.id).order_by(Notification.id.desc()).limit(100)]

class AppointmentIn(BaseModel):
    doctor: str
    specialty: str = ""
    hospital: str = ""
    starts_at: datetime
    purpose: str
    notes: str = ""
    reminder_minutes: int = 60
class RoutineIn(BaseModel):
    name: str
    instructions: str = ""
    times: list[str] = []
class NoteIn(BaseModel): body: str
class HandoverIn(BaseModel):
    from_label: str
    to_label: str
    summary: str
    pending_tasks: str = ""
class CareTaskIn(BaseModel):
    assignee_id: int
    title: str
    due_at: datetime | None = None
class CareTaskStatus(BaseModel): status: str
class RoutineCheckIn(BaseModel): routine_id: int; scheduled_for: datetime; status: str
class PrescriptionLookupIn(BaseModel): medicine_name: str
class PrescriptionMatchDecision(BaseModel): action: str; rxcui: str | None = None
class ReminderSettingsIn(BaseModel):
    initial_minutes: int | None = None
    followup_minutes: int | None = None
    escalation_minutes: int | None = None
    notify_caretakers: bool | None = None
    notify_family: bool | None = None

def appointment_out(item):
    return {"id": item.id, "doctor": item.doctor, "specialty": item.specialty, "hospital": item.hospital,
            "starts_at": item.starts_at, "purpose": item.purpose, "notes": item.notes,
            "reminder_minutes": item.reminder_minutes, "status": item.status}
@app.get("/patients/{pid}/appointments")
def list_appointments(pid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid)
    return [appointment_out(item) for item in s.query(Appointment).filter_by(patient_id=pid).order_by(Appointment.starts_at)]
@app.post("/patients/{pid}/appointments")
def add_appointment(pid: int, b: AppointmentIn, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_manage_appointments")
    if b.reminder_minutes < 0 or b.reminder_minutes > 10080: raise HTTPException(422, "Reminder must be within 7 days")
    item = Appointment(patient_id=pid, **b.model_dump()); s.add(item); s.commit()
    audit(s, pid, u.id, f"appointment_added:{item.id}"); return appointment_out(item)
@app.put("/patients/{pid}/appointments/{aid}")
def edit_appointment(pid: int, aid: int, b: AppointmentIn, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_manage_appointments")
    item = s.query(Appointment).filter_by(id=aid, patient_id=pid).first()
    if not item: raise HTTPException(404, "Appointment not found")
    for key, value in b.model_dump().items(): setattr(item, key, value)
    s.commit(); audit(s, pid, u.id, f"appointment_updated:{aid}"); return appointment_out(item)
@app.delete("/patients/{pid}/appointments/{aid}")
def cancel_appointment(pid: int, aid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_manage_appointments")
    item = s.query(Appointment).filter_by(id=aid, patient_id=pid).first()
    if not item: raise HTTPException(404, "Appointment not found")
    item.status = "cancelled"; s.commit(); audit(s, pid, u.id, f"appointment_cancelled:{aid}"); return {"ok": True}

@app.get("/patients/{pid}/routines")
def list_routines(pid: int, day: date | None = None, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid); selected = day or date.today(); out = []
    for item in s.query(Routine).filter_by(patient_id=pid, active=True):
        for raw_time in filter(None, item.times.split(",")):
            scheduled = datetime.combine(selected, dtime.fromisoformat(raw_time))
            check = s.query(RoutineLog).filter_by(routine_id=item.id, scheduled_for=scheduled).first()
            out.append({"id": item.id, "name": item.name, "instructions": item.instructions,
                        "scheduled_for": scheduled, "status": check.status if check else "unconfirmed"})
    return sorted(out, key=lambda row: row["scheduled_for"])
@app.get("/patients/{pid}/routines/templates")
def list_routine_templates(pid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid)
    return [{"id": item.id, "name": item.name, "instructions": item.instructions,
             "times": list(filter(None, item.times.split(",")))}
            for item in s.query(Routine).filter_by(patient_id=pid, active=True)]
@app.post("/patients/{pid}/routines")
def add_routine(pid: int, b: RoutineIn, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_manage_routines")
    check_times(b.times)
    item = Routine(patient_id=pid, name=b.name, instructions=b.instructions, times=",".join(b.times))
    s.add(item); s.commit(); audit(s, pid, u.id, f"routine_added:{item.id}")
    return {"id": item.id, "name": item.name, "instructions": item.instructions, "times": b.times}
@app.put("/patients/{pid}/routines/{rid}")
def edit_routine(pid: int, rid: int, b: RoutineIn, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_manage_routines"); check_times(b.times)
    item = s.query(Routine).filter_by(id=rid, patient_id=pid, active=True).first()
    if not item: raise HTTPException(404, "Routine not found")
    item.name, item.instructions, item.times = b.name, b.instructions, ",".join(b.times)
    s.commit(); audit(s, pid, u.id, f"routine_updated:{rid}"); return {"id": item.id, "name": item.name, "times": b.times}
@app.delete("/patients/{pid}/routines/{rid}")
def delete_routine(pid: int, rid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_manage_routines")
    item = s.query(Routine).filter_by(id=rid, patient_id=pid).first()
    if not item: raise HTTPException(404, "Routine not found")
    item.active = False; s.commit(); audit(s, pid, u.id, f"routine_archived:{rid}"); return {"ok": True}
@app.post("/patients/{pid}/routines/check-in")
def check_in_routine(pid: int, b: RoutineCheckIn, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_confirm_doses")
    if b.status not in ("done", "skipped"): raise HTTPException(422, "Status must be done or skipped")
    item = s.query(Routine).filter_by(id=b.routine_id, patient_id=pid, active=True).first()
    if not item: raise HTTPException(404, "Routine not found")
    log = s.query(RoutineLog).filter_by(routine_id=item.id, scheduled_for=b.scheduled_for).first()
    if not log: log = RoutineLog(routine_id=item.id, scheduled_for=b.scheduled_for, actor_id=u.id, status=b.status); s.add(log)
    else: log.actor_id, log.status, log.recorded_at = u.id, b.status, now()
    s.commit(); audit(s, pid, u.id, f"routine_{b.status}:{item.id}"); return {"ok": True}

@app.get("/patients/{pid}/notes")
def list_notes(pid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid)
    return [{"id": n.id, "author_id": n.author_id, "body": n.body, "created_at": n.created_at}
            for n in s.query(CareNote).filter_by(patient_id=pid).order_by(CareNote.id.desc()).limit(100)]
@app.post("/patients/{pid}/notes")
def add_note(pid: int, b: NoteIn, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_write_notes")
    if not b.body.strip(): raise HTTPException(422, "Note cannot be empty")
    item = CareNote(patient_id=pid, author_id=u.id, body=b.body.strip()); s.add(item); s.commit()
    audit(s, pid, u.id, "care_note_added"); return {"id": item.id, "body": item.body, "created_at": item.created_at}
@app.get("/patients/{pid}/handovers")
def list_handovers(pid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid)
    return [{"id": h.id, "author_id": h.author_id, "from_label": h.from_label, "to_label": h.to_label,
             "summary": h.summary, "pending_tasks": h.pending_tasks, "created_at": h.created_at}
            for h in s.query(Handover).filter_by(patient_id=pid).order_by(Handover.id.desc()).limit(100)]
@app.post("/patients/{pid}/handovers")
def add_handover(pid: int, b: HandoverIn, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid)
    item = Handover(patient_id=pid, author_id=u.id, **b.model_dump()); s.add(item); s.commit()
    audit(s, pid, u.id, "care_handover_added"); return {"id": item.id, "summary": item.summary, "created_at": item.created_at}
@app.get("/patients/{pid}/tasks")
def list_tasks(pid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid)
    return [{"id": task.id, "assignee_id": task.assignee_id, "assigned_by": task.assigned_by,
             "assignee_name": s.get(User, task.assignee_id).name, "title": task.title, "due_at": task.due_at,
             "status": task.status, "created_at": task.created_at, "completed_at": task.completed_at,
             "is_assigned_to_me": task.assignee_id == u.id}
            for task in s.query(CareTask).filter_by(patient_id=pid).order_by(CareTask.id.desc())]
@app.post("/patients/{pid}/tasks")
def add_task(pid: int, b: CareTaskIn, u: User = Depends(me), s: Session = Depends(db)):
    if access(s, u, pid).role != "patient": raise HTTPException(403, "Only the patient can assign care tasks")
    member = s.query(Member).filter_by(patient_id=pid, user_id=b.assignee_id).first()
    if not member or member.role == "patient": raise HTTPException(422, "Choose a member of this care team")
    if not b.title.strip(): raise HTTPException(422, "Task title cannot be empty")
    task = CareTask(patient_id=pid, assignee_id=b.assignee_id, assigned_by=u.id, title=b.title.strip(), due_at=b.due_at)
    s.add(task); s.commit(); audit(s, pid, u.id, f"care_task_assigned:{task.id}"); return {"id": task.id, "status": task.status}
@app.patch("/patients/{pid}/tasks/{task_id}")
def update_task(pid: int, task_id: int, b: CareTaskStatus, u: User = Depends(me), s: Session = Depends(db)):
    member = access(s, u, pid)
    task = s.query(CareTask).filter_by(id=task_id, patient_id=pid).first()
    if not task: raise HTTPException(404, "Task not found")
    if u.id not in (task.assignee_id, task.assigned_by) and member.role != "patient": raise HTTPException(403, "Task access not granted")
    if b.status not in ("pending", "completed"): raise HTTPException(422, "Status must be pending or completed")
    task.status = b.status; task.completed_at = now() if b.status == "completed" else None
    s.commit(); audit(s, pid, u.id, f"care_task_{b.status}:{task.id}"); return {"id": task.id, "status": task.status}

def prescription_out(item):
    return {"id": item.id, "filename": item.filename, "status": item.status, "uploaded_at": item.uploaded_at,
            "extracted_text": item.extracted_text or "", "extracted_fields": json.loads(item.extracted_fields or "[]"),
            "analysis_status": item.analysis_status or "not_analyzed",
            "analysis": json.loads(item.analysis_result or "[]"), "ocr_confidence": item.ocr_confidence}

def _tesseract():
    if os.getenv("OCR_ENABLED", "1") != "1": raise HTTPException(503, "Prescription OCR is disabled. Set OCR_ENABLED=1 on the backend.")
    try:
        import pytesseract
    except ImportError as exc:
        raise HTTPException(503, "Install pytesseract and the Tesseract OCR executable on the backend.") from exc
    command = os.getenv("TESSERACT_CMD") or shutil.which("tesseract")
    if not command:
        for candidate in (r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"):
            if Path(candidate).is_file(): command = candidate; break
    if not command or not Path(command).is_file():
        raise HTTPException(503, "Tesseract is not installed or found. Install it and set TESSERACT_CMD on the backend.")
    pytesseract.pytesseract.tesseract_cmd = command
    return pytesseract

def _ocr_image(image):
    from PIL import ImageEnhance, ImageOps
    pytesseract = _tesseract()
    image = ImageOps.grayscale(image)
    image = ImageOps.autocontrast(image)
    if max(image.size) < 1800:
        scale = min(3, max(1, 1800 // max(image.size)))
        if scale > 1: image = image.resize((image.width * scale, image.height * scale))
    image = ImageEnhance.Contrast(image).enhance(1.35)
    passes = []
    for page_mode in (6, 11):
        config = f"--oem 1 --psm {page_mode}"
        data = pytesseract.image_to_data(image, lang="eng", config=config, output_type=pytesseract.Output.DICT)
        text_value = pytesseract.image_to_string(image, lang="eng", config=config).strip()
        confidences = [float(value) for value, word in zip(data["conf"], data["text"]) if word.strip() and float(value) >= 0]
        score = sum(confidences) / len(confidences) if confidences else None
        passes.append((score or 0, text_value, score))
    _, text_value, score = max(passes, key=lambda result: result[0])
    return text_value, round(score, 1) if score is not None else None

def extract_prescription_text(content: bytes, suffix: str):
    from io import BytesIO
    from PIL import Image
    if suffix != ".pdf":
        try: return _ocr_image(Image.open(BytesIO(content)))
        except HTTPException: raise
        except Exception as exc: raise HTTPException(422, "OCR could not read this image. Try a clearer JPG or PNG.") from exc
    try:
        import pymupdf
        document = pymupdf.open(stream=content, filetype="pdf")
        if document.page_count == 0: raise HTTPException(422, "The PDF has no pages.")
        try: max_pages = max(1, min(20, int(os.getenv("MAX_PDF_OCR_PAGES", "10"))))
        except ValueError: max_pages = 10
        texts, scores = [], []
        for page in document[:max_pages]:
            embedded = page.get_text("text").strip()
            if embedded:
                texts.append(embedded); continue
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2.5, 2.5), alpha=False)
            page_text, score = _ocr_image(Image.open(BytesIO(pixmap.tobytes("png"))))
            if page_text: texts.append(page_text)
            if score is not None: scores.append(score)
        confidence = round(sum(scores) / len(scores), 1) if scores else None
        suffix_message = "" if document.page_count <= max_pages else f"\n[Only the first {max_pages} pages were analyzed.]"
        return "\n\n".join(texts) + suffix_message, confidence
    except HTTPException: raise
    except ImportError as exc: raise HTTPException(503, "Scanned PDF OCR requires PyMuPDF on the backend.") from exc
    except Exception as exc: raise HTTPException(422, "The PDF could not be processed. Try exporting it again.") from exc

def prescription_candidates(raw_text: str):
    dose_pattern = re.compile(r"\b\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|iu|units?|%)\b", re.IGNORECASE)
    frequency_pattern = re.compile(r"\b(?:once|twice|three times|four times|\d+ times|every\s+\d+\s+hours?)(?:\s+a\s+day|\s+daily|\s+per\s+day)?\b", re.IGNORECASE)
    duration_pattern = re.compile(r"\bfor\s+\d+\s+(?:days?|weeks?|months?)\b", re.IGNORECASE)
    candidates = []
    for raw_line in raw_text.splitlines():
        for line in raw_line.split(";"):
            line = re.sub(r"\s+", " ", line).strip(" \t-*")
            prefix = re.sub(r"^(?:rx|med(?:icine)?|\d+[.)])\s*[:.)-]?\s*", "", line, flags=re.IGNORECASE)
            dose = dose_pattern.search(prefix)
            name = prefix[:dose.start()].strip(" :-\t") if dose else ""
            if not name and re.match(r"^\s*(?:rx|med(?:icine)?)\s*:", line, re.IGNORECASE):
                name = re.sub(r"^\s*(?:rx|med(?:icine)?)\s*:\s*", "", line, flags=re.IGNORECASE).strip()
            if not name: continue
            candidates.append({"medicine_name": name, "dosage": dose.group(0) if dose else None,
                               "frequency": (match.group(0) if (match := frequency_pattern.search(line)) else None),
                               "duration": (match.group(0) if (match := duration_pattern.search(line)) else None),
                               "source_line": line})
    return candidates[:30]

def _external_json(base: str, path: str, parameters: dict[str, str]):
    endpoint = f"{base}/{path}" if path else base
    url = f"{endpoint}?{urlencode(parameters)}"
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "CareSyncAI prescription review"})
    with urlopen(request, timeout=12) as response:
        return json.loads(response.read().decode("utf-8"))

def _rxnorm(path: str, **parameters):
    return _external_json("https://rxnav.nlm.nih.gov/REST", path, parameters)

def _normalized_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())

def _rx_properties(rxcui: str):
    result = _rxnorm(f"rxcui/{rxcui}/properties.json")
    return result.get("properties")

def _rx_related_names(rxcui: str, term_type: str):
    try:
        result = _rxnorm(f"rxcui/{rxcui}/related.json", tty=term_type)
    except (HTTPError, URLError, TimeoutError, ValueError): return []
    groups = result.get("relatedGroup", {}).get("conceptGroup", [])
    return list(dict.fromkeys(concept.get("name", "") for group in groups
                              for concept in group.get("conceptProperties", []) if concept.get("name")))

def _label_text(record: dict, *keys: str, limit: int = 1800):
    for key in keys:
        values = record.get(key)
        if isinstance(values, list):
            for value in values:
                cleaned = re.sub(r"\s+", " ", str(value)).strip()
                if cleaned: return cleaned[:limit]
    return ""

def _fda_label(generic_name: str, brand_name: str = ""):
    terms = [term for term in (generic_name, brand_name) if term]
    for term in terms:
        try:
            parameters = {"search": f'openfda.generic_name:"{term}" OR openfda.brand_name:"{term}"', "limit": "1"}
            if os.getenv("OPENFDA_API_KEY"): parameters["api_key"] = os.environ["OPENFDA_API_KEY"]
            response = _external_json("https://api.fda.gov/drug/label.json", "", parameters)
            records = response.get("results", [])
            if records: return records[0]
        except (HTTPError, URLError, TimeoutError, ValueError): continue
    return {}

def medicine_information(rxcui: str, properties: dict):
    related_ingredients = _rx_related_names(rxcui, "IN")
    generic_name = related_ingredients[0] if related_ingredients else properties.get("name", "")
    label = _fda_label(generic_name, properties.get("name", ""))
    openfda = label.get("openfda", {}) if label else {}
    brand = (openfda.get("brand_name") or [""])[0]
    if not brand:
        brands = _rx_related_names(rxcui, "BN")
        brand = brands[0] if brands else ""
    category_values = openfda.get("pharm_class_epc") or openfda.get("pharm_class_cs") or []
    category = category_values[0] if category_values else ((openfda.get("product_type") or [""])[0])
    set_id = label.get("set_id", "")
    label_url = f"https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid={set_id}" if set_id else "https://open.fda.gov/apis/drug/label/"
    return {"name": properties.get("name", ""), "generic_name": generic_name, "brand_name": brand,
            "category": category, "what_is_it": _label_text(label, "description", "purpose"),
            "uses": _label_text(label, "indications_and_usage", "purpose"),
            "mechanism": _label_text(label, "mechanism_of_action"),
            "side_effects": _label_text(label, "adverse_reactions"),
            "precautions": {"warnings": _label_text(label, "warnings", "warnings_and_cautions"),
                            "precautions": _label_text(label, "precautions"),
                            "contraindications": _label_text(label, "contraindications", "do_not_use")},
            "sources": [{"name": "RxNorm (NLM)", "url": f"https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm={rxcui}"},
                        {"name": "FDA-approved drug label (DailyMed)", "url": label_url}],
            "label_available": bool(label)}

def identify_medicine(candidate: dict):
    term = candidate.get("medicine_name", "").strip()
    try: min_confidence = float(os.getenv("OCR_MIN_CONFIDENCE", "50"))
    except ValueError: min_confidence = 50
    low_ocr_confidence = candidate.get("ocr_confidence") is not None and candidate["ocr_confidence"] < min_confidence
    result = {**candidate, "match_status": "unable_to_identify", "matches": [], "medicine": None,
              "message": "Unable to verify this medicine. Please consult a qualified pharmacist."}
    if not term: return result
    try:
        identifiers = []
        for search in (0, 1):
            found = _rxnorm("rxcui.json", name=term, search=str(search)).get("idGroup", {}).get("rxnormId", [])
            identifiers.extend(found)
        for rxcui in dict.fromkeys(identifiers):
            properties = _rx_properties(rxcui)
            if not properties: continue
            exact_terms = [properties.get("name", ""), properties.get("synonym", "")]
            if _normalized_name(term) in {_normalized_name(value) for value in exact_terms if value}:
                result["matches"] = [{"rxcui": rxcui, "name": properties.get("name", ""), "source": "RxNorm exact/normalized name"}]
                if low_ocr_confidence:
                    result.update(match_status="needs_confirmation", message="OCR confidence is low. Review the original prescription and confirm this exact RxNorm name match.")
                else:
                    result.update(match_status="verified", medicine=medicine_information(rxcui, properties),
                                  message="Exact medicine name matched in RxNorm.")
                return result
    except (HTTPError, URLError, TimeoutError, ValueError, KeyError):
        result.update(match_status="lookup_unavailable", message="The RxNorm medicine service is unavailable. Retry later; this medicine has not been verified.")
        return result
    try:
        found = _rxnorm("approximateTerm.json", term=term, maxEntries="5").get("approximateGroup", {}).get("candidate", [])
        matches = [{"rxcui": row.get("rxcui", ""), "name": row.get("name", ""),
                    "score": int(row["score"]) if str(row.get("score", "")).isdigit() else None}
                   for row in found if row.get("rxcui") and row.get("name")]
        if matches:
            result.update(match_status="needs_confirmation", matches=matches,
                          message="Possible RxNorm matches found. Review and confirm one, or reject them. Approximate matches are never verified automatically.")
        else:
            result.update(match_status="unable_to_identify")
    except (HTTPError, URLError, TimeoutError, ValueError, KeyError):
        result.update(match_status="lookup_unavailable", message="The RxNorm medicine service is unavailable. Retry later; this medicine has not been verified.")
    return result

def confirm_medicine_match(result: dict, rxcui: str):
    if not any(match.get("rxcui") == rxcui for match in result.get("matches", [])):
        raise HTTPException(422, "Choose one of the RxNorm suggestions returned for this medicine.")
    try: properties = _rx_properties(rxcui)
    except (HTTPError, URLError, TimeoutError, ValueError): properties = None
    if not properties:
        raise HTTPException(503, "RxNorm is unavailable. The medicine was not verified.")
    result["match_status"] = "verified"
    result["medicine"] = medicine_information(rxcui, properties)
    result["confirmed_rxcui"] = rxcui
    result["message"] = "You confirmed this RxNorm match. Verify the printed prescription with a pharmacist before use."
    return result

@app.get("/patients/{pid}/prescriptions")
def list_prescriptions(pid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid)
    return [prescription_out(item) for item in s.query(Prescription).filter_by(patient_id=pid).order_by(Prescription.id.desc())]
@app.get("/patients/{pid}/prescriptions/{rid}/file")
def view_prescription_file(pid: int, rid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid)
    item = s.query(Prescription).filter_by(id=rid, patient_id=pid).first()
    if not item: raise HTTPException(404, "Prescription not found")
    stored = Path(item.storage_path).resolve()
    if not stored.is_file(): raise HTTPException(404, "Prescription file is no longer available")
    return FileResponse(stored, media_type=item.content_type, filename=item.filename,
                        content_disposition_type="inline", headers={"Cache-Control": "private, no-store"})
@app.post("/patients/{pid}/prescriptions", status_code=201)
async def upload_prescription(pid: int, file: UploadFile = File(...), u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_edit_meds")
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in (".jpg", ".jpeg", ".png", ".pdf"): raise HTTPException(415, "Upload a JPG, PNG, or PDF")
    content = await file.read(10 * 1024 * 1024 + 1)
    if len(content) > 10 * 1024 * 1024: raise HTTPException(413, "Maximum upload size is 10 MB")
    signatures = {".jpg": content.startswith(b"\xff\xd8\xff"), ".jpeg": content.startswith(b"\xff\xd8\xff"),
                  ".png": content.startswith(b"\x89PNG\r\n\x1a\n"), ".pdf": content.startswith(b"%PDF-")}
    if not signatures[suffix]: raise HTTPException(415, "File content does not match its extension")
    try:
        from io import BytesIO
        if suffix == ".pdf":
            from pypdf import PdfReader
            if not PdfReader(BytesIO(content), strict=True).pages: raise ValueError("empty PDF")
        else:
            from PIL import Image
            Image.open(BytesIO(content)).verify()
    except Exception:
        raise HTTPException(415, "The uploaded file is not a valid image or PDF")
    directory = UPLOAD_DIR / str(pid)
    directory.mkdir(parents=True, exist_ok=True)
    stored = directory / f"{secrets.token_hex(16)}{suffix}"; stored.write_bytes(content)
    item = Prescription(patient_id=pid, uploaded_by=u.id, filename=Path(file.filename or "prescription").name,
                        content_type=file.content_type or "application/octet-stream", storage_path=str(stored),
                        extracted_text="", extracted_fields="[]", analysis_status="not_analyzed",
                        analysis_result="[]", status="pending_review")
    s.add(item); s.commit(); audit(s, pid, u.id, f"prescription_uploaded:{item.id}"); return prescription_out(item)
@app.post("/patients/{pid}/prescriptions/{rid}/analyze")
def analyze_prescription(pid: int, rid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_edit_meds")
    item = s.query(Prescription).filter_by(id=rid, patient_id=pid).first()
    if not item: raise HTTPException(404, "Prescription not found")
    stored = Path(item.storage_path)
    if not stored.is_file(): raise HTTPException(404, "Prescription file is no longer available")
    text_value, confidence = extract_prescription_text(stored.read_bytes(), Path(item.filename).suffix.lower())
    candidates = prescription_candidates(text_value)
    for candidate in candidates: candidate["ocr_confidence"] = confidence
    item.extracted_text = text_value
    item.extracted_fields = json.dumps(candidates)
    item.analysis_result = json.dumps([identify_medicine(candidate) for candidate in candidates])
    item.analysis_status = "complete"
    item.ocr_confidence = confidence
    s.commit(); audit(s, pid, u.id, f"prescription_analyzed:{rid}"); return prescription_out(item)
@app.post("/patients/{pid}/prescriptions/{rid}/lookup")
def lookup_prescription_medicine(pid: int, rid: int, b: PrescriptionLookupIn, u: User = Depends(me), s: Session = Depends(db)):
    member = access(s, u, pid)
    if member.role != "patient": raise HTTPException(403, "Only the patient can add or confirm medicine lookup terms")
    term = b.medicine_name.strip()
    if not term or len(term) > 120: raise HTTPException(422, "Enter a medicine name up to 120 characters")
    item = s.query(Prescription).filter_by(id=rid, patient_id=pid).first()
    if not item: raise HTTPException(404, "Prescription not found")
    results = json.loads(item.analysis_result or "[]")
    results.append(identify_medicine({"medicine_name": term, "dosage": None, "frequency": None, "duration": None, "source_line": "Manually entered for lookup"}))
    item.analysis_result = json.dumps(results); item.analysis_status = "complete"
    s.commit(); audit(s, pid, u.id, f"prescription_medicine_lookup:{rid}"); return prescription_out(item)
@app.post("/patients/{pid}/prescriptions/{rid}/matches/{candidate_index}")
def decide_prescription_match(pid: int, rid: int, candidate_index: int, b: PrescriptionMatchDecision,
                              u: User = Depends(me), s: Session = Depends(db)):
    member = access(s, u, pid)
    if member.role != "patient": raise HTTPException(403, "Only the patient can confirm or reject a medicine match")
    if b.action not in ("confirm", "reject"): raise HTTPException(422, "Action must be confirm or reject")
    item = s.query(Prescription).filter_by(id=rid, patient_id=pid).first()
    if not item: raise HTTPException(404, "Prescription not found")
    results = json.loads(item.analysis_result or "[]")
    if candidate_index < 0 or candidate_index >= len(results): raise HTTPException(404, "Medicine candidate not found")
    result = results[candidate_index]
    if b.action == "confirm":
        if not b.rxcui: raise HTTPException(422, "Select an RxNorm match to confirm")
        confirm_medicine_match(result, b.rxcui)
    else:
        result["matches"] = [match for match in result.get("matches", []) if match.get("rxcui") != b.rxcui]
        if not result["matches"]:
            result["match_status"] = "unable_to_identify"
            result["message"] = "Unable to verify this medicine. Please consult a qualified pharmacist."
        else:
            result["match_status"] = "needs_confirmation"
    item.analysis_result = json.dumps(results); item.reviewer_id = u.id
    s.commit(); audit(s, pid, u.id, f"prescription_match_{b.action}:{rid}:{candidate_index}"); return prescription_out(item)
@app.delete("/patients/{pid}/prescriptions/{rid}")
def delete_prescription(pid: int, rid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid, "can_edit_meds")
    item = s.query(Prescription).filter_by(id=rid, patient_id=pid).first()
    if not item: raise HTTPException(404, "Prescription not found")
    Path(item.storage_path).unlink(missing_ok=True)
    s.delete(item); s.commit(); audit(s, pid, u.id, f"prescription_deleted:{rid}"); return {"ok": True}

def settings_out(item):
    return {"initial_minutes": item.initial_minutes, "followup_minutes": item.followup_minutes,
            "escalation_minutes": item.escalation_minutes, "notify_caretakers": item.notify_caretakers,
            "notify_family": item.notify_family}
@app.get("/patients/{pid}/reminder-settings")
def get_reminder_settings(pid: int, u: User = Depends(me), s: Session = Depends(db)):
    access(s, u, pid)
    return settings_out(s.get(CareSettings, pid) or CareSettings(patient_id=pid, initial_minutes=5,
        followup_minutes=30, escalation_minutes=45, notify_caretakers=True, notify_family=True))
@app.patch("/patients/{pid}/reminder-settings")
def update_reminder_settings(pid: int, b: ReminderSettingsIn, u: User = Depends(me), s: Session = Depends(db)):
    if access(s, u, pid).role != "patient": raise HTTPException(403, "Only the patient can change escalation settings")
    item = s.get(CareSettings, pid) or CareSettings(patient_id=pid, initial_minutes=5,
        followup_minutes=30, escalation_minutes=45, notify_caretakers=True, notify_family=True)
    if item not in s: s.add(item)
    changes = b.model_dump(exclude_unset=True)
    for key in ("initial_minutes", "followup_minutes", "escalation_minutes"):
        if key in changes and not 0 <= changes[key] <= 1440: raise HTTPException(422, f"{key} must be between 0 and 1440")
    for key, value in changes.items(): setattr(item, key, value)
    s.commit(); audit(s, pid, u.id, "reminder_settings_updated"); return settings_out(item)
