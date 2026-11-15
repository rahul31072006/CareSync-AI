import os; os.environ["DATABASE_URL"] = "sqlite:///./test.db"; os.environ["DISABLE_SCHEDULER"] = "1"; os.environ["OCR_ENABLED"] = "1"
import shutil
from pathlib import Path
from fastapi.testclient import TestClient
from main import app
from datetime import date, datetime, timedelta
from io import BytesIO
from uuid import uuid4
from PIL import Image
from pypdf import PdfWriter
c = TestClient(app)
def tok(e):
    response = c.post("/auth/register", json={"email": e, "name": e, "password": "password123"})
    assert response.status_code == 200
    result = c.post("/auth/login", data={"username": e, "password": "password123"})
    assert result.status_code == 200
    return {"Authorization": "Bearer " + result.json()["access_token"]}
def test_flow():
    suffix = uuid4().hex
    email_only = f"first-{suffix}@example.com"
    assert c.post("/auth/register", json={"email": email_only, "password": "password123"}).status_code == 200
    assert c.post("/auth/login", data={"username": email_only, "password": "password123"}).status_code == 200
    p, f, x = tok(f"p-{suffix}@example.com"), tok(f"f-{suffix}@example.com"), tok(f"x-{suffix}@example.com")
    pid = c.post("/patients?name=Asha", headers=p).json()["id"]
    code = c.post(f"/patients/{pid}/invites?role=family", headers=p).json()["code"]
    assert c.post(f"/invites/{code}/accept", headers=f).status_code == 200
    assert c.post(f"/invites/{code}/accept", headers=x).status_code == 400  # single use
    assert c.get(f"/patients/{pid}/medications", headers=x).status_code == 404  # isolation
    revoked_code = c.post(f"/patients/{pid}/invites?role=caretaker", headers=p).json()["code"]
    assert c.delete(f"/patients/{pid}/invites/{revoked_code}", headers=p).status_code == 200
    assert c.post(f"/invites/{revoked_code}/accept", headers=x).status_code == 400
    med = {"name": "Sample medicine", "dosage": "as prescribed", "frequency": "as prescribed", "start_date": str(date.today()), "times": ["08:00", "20:00"]}
    assert c.post(f"/patients/{pid}/medications", json=med, headers=f).status_code == 403  # no permission yet
    mid = c.post(f"/patients/{pid}/medications", json=med, headers=p).json()["id"]
    d = c.get(f"/patients/{pid}/doses", headers=f).json()
    assert len(d) == 2 and d[0]["status"] == "unconfirmed"
    body = {"medication_id": mid, "scheduled_for": d[0]["scheduled_for"], "status": "taken"}
    invalid_time = datetime.fromisoformat(d[0]["scheduled_for"]) + timedelta(minutes=5)
    assert c.post(f"/patients/{pid}/doses/confirm", json={**body, "scheduled_for": invalid_time.isoformat()}, headers=p).status_code == 422
    assert c.post(f"/patients/{pid}/doses/confirm", json=body, headers=f).status_code == 403
    assert c.post(f"/patients/{pid}/doses/confirm", json=body, headers=p).status_code == 200
    assert c.get(f"/patients/{pid}/doses", headers=f).json()[0]["status"] == "taken"

    assert c.get(f"/patients/{pid}/reminder-settings", headers=p).json()["followup_minutes"] == 30
    assert c.patch(f"/patients/{pid}/reminder-settings", json={"followup_minutes": 20}, headers=f).status_code == 403
    family_user_id = next(item["user_id"] for item in c.get(f"/patients/{pid}/members", headers=p).json() if item["role"] == "family")
    permissions = {"can_confirm_doses": True, "can_manage_appointments": True, "can_manage_routines": True, "can_write_notes": True}
    assert c.patch(f"/patients/{pid}/members/{family_user_id}", params=permissions, headers=p).status_code == 200
    assert c.post(f"/patients/{pid}/doses/confirm", json={**body, "status": "skipped"}, headers=f).status_code == 200

    appointment = {"doctor": "Dr. Sample", "specialty": "Primary care", "hospital": "Sample clinic",
                       "starts_at": (datetime.now() + timedelta(days=2)).isoformat(), "purpose": "Routine visit",
                   "notes": "Sample record", "reminder_minutes": 60}
    assert c.post(f"/patients/{pid}/appointments", json=appointment, headers=f).status_code == 200
    assert len(c.get(f"/patients/{pid}/appointments", headers=p).json()) == 1

    routine = {"name": "Sample walk", "instructions": "Doctor-approved routine", "times": ["09:00"]}
    assert c.post(f"/patients/{pid}/routines", json=routine, headers=f).status_code == 200
    assert c.get(f"/patients/{pid}/routines/templates", headers=p).json()[0]["name"] == routine["name"]
    assert c.post(f"/patients/{pid}/notes", json={"body": "Sample care note"}, headers=f).status_code == 200
    handover = {"from_label": "Day", "to_label": "Evening", "summary": "Sample handover"}
    assert c.post(f"/patients/{pid}/handovers", json=handover, headers=f).status_code == 200
    task_body = {"assignee_id": family_user_id, "title": "Confirm sample clinic appointment"}
    assert c.post(f"/patients/{pid}/tasks", json=task_body, headers=f).status_code == 403
    task = c.post(f"/patients/{pid}/tasks", json=task_body, headers=p)
    assert task.status_code == 200
    task_id = task.json()["id"]
    assert c.patch(f"/patients/{pid}/tasks/{task_id}", json={"status": "completed"}, headers=x).status_code == 404
    assert c.patch(f"/patients/{pid}/tasks/{task_id}", json={"status": "completed"}, headers=f).status_code == 200

    image_buffer = BytesIO()
    Image.new("RGB", (2, 2), color="white").save(image_buffer, format="PNG")
    image = image_buffer.getvalue()
    upload = c.post(f"/patients/{pid}/prescriptions", files={"file": ("sample.png", image, "image/png")}, headers=p)
    assert upload.status_code == 201
    prescription_id = upload.json()["id"]
    assert upload.json()["status"] == "pending_review"
    assert upload.json()["analysis_status"] == "not_analyzed" and upload.json()["analysis"] == []
    assert c.get(f"/patients/{pid}/prescriptions/{prescription_id}/file", headers=x).status_code == 404
    assert c.get(f"/patients/{pid}/prescriptions/{prescription_id}/file", headers=p).content == image
    invalid = c.post(f"/patients/{pid}/prescriptions", files={"file": ("invalid.txt", b"not an image", "text/plain")}, headers=p)
    assert invalid.status_code == 415
    oversized = c.post(f"/patients/{pid}/prescriptions", files={"file": ("large.png", b"x" * (10 * 1024 * 1024 + 1), "image/png")}, headers=p)
    assert oversized.status_code == 413
    tesseract = os.getenv("TESSERACT_CMD") or shutil.which("tesseract") or r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    analyzed = c.post(f"/patients/{pid}/prescriptions/{prescription_id}/analyze", headers=p)
    if Path(tesseract).is_file():
        assert analyzed.status_code == 200
        assert analyzed.json()["analysis_status"] == "complete"
        assert all(result["match_status"] != "verified" for result in analyzed.json()["analysis"])
    else:
        assert analyzed.status_code == 503
    pdf_buffer = BytesIO()
    pdf_writer = PdfWriter()
    pdf_writer.add_blank_page(width=200, height=200)
    pdf_writer.write(pdf_buffer)
    pdf_upload = c.post(f"/patients/{pid}/prescriptions", files={"file": ("blank.pdf", pdf_buffer.getvalue(), "application/pdf")}, headers=p)
    assert pdf_upload.status_code == 201
    pdf_id = pdf_upload.json()["id"]
    pdf_analysis = c.post(f"/patients/{pid}/prescriptions/{pdf_id}/analyze", headers=p)
    if Path(tesseract).is_file():
        assert pdf_analysis.status_code == 200 and pdf_analysis.json()["analysis_status"] == "complete"
        assert all(result["match_status"] != "verified" for result in pdf_analysis.json()["analysis"])
    else:
        assert pdf_analysis.status_code == 503
    assert c.get(f"/patients/{pid}/prescriptions", headers=p).json()[0]["status"] == "pending_review"
    assert len(c.get(f"/patients/{pid}/medications", headers=p).json()) == 1  # verification never activates a medicine
    assert c.delete(f"/patients/{pid}/prescriptions/{prescription_id}", headers=f).status_code == 403
    assert c.delete(f"/patients/{pid}/prescriptions/{prescription_id}", headers=p).status_code == 200
    assert c.delete(f"/patients/{pid}/prescriptions/{pdf_id}", headers=p).status_code == 200
