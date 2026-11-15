export type Patient = { id: number; name: string; role: 'patient' | 'family' | 'caretaker' }
export type Medication = {
  id: number; name: string; dosage: string; frequency: string; instructions: string
  start_date: string; end_date: string | null; times: string[]
}
export type Dose = {
  medication_id: number; name: string; dosage: string; scheduled_for: string; status: string
  confirmed_by: number | null; recorded_at: string | null
}
export type Appointment = {
  id: number; doctor: string; specialty: string; hospital: string; starts_at: string
  purpose: string; notes: string; reminder_minutes: number; status: string
}
export type Routine = { id: number; name: string; instructions: string; scheduled_for: string; status: string }
export type RoutineTemplate = { id: number; name: string; instructions: string; times: string[] }
export type Member = {
  user_id: number; name: string; email: string; role: string; can_confirm_doses: boolean; can_edit_meds: boolean
  can_manage_appointments: boolean; can_manage_routines: boolean; can_write_notes: boolean
}
export type Note = { id: number; author_id: number; body: string; created_at: string }
export type Handover = {
  id: number; author_id: number; from_label: string; to_label: string; summary: string; pending_tasks: string; created_at: string
}
export type CareTask = {
  id: number; assignee_id: number; assigned_by: number; assignee_name: string; title: string; due_at: string | null
  status: string; created_at: string; completed_at: string | null; is_assigned_to_me: boolean
}
export type Prescription = {
  id: number; filename: string; status: string; uploaded_at: string; extracted_text: string
  extracted_fields: PrescriptionCandidate[]; analysis_status: string; analysis: PrescriptionMedicineResult[]
  ocr_confidence: number | null
}
export type PrescriptionCandidate = {
  medicine_name: string; dosage: string | null; frequency: string | null; duration: string | null; source_line: string
  ocr_confidence?: number | null
}
export type PrescriptionMedicineMatch = { rxcui: string; name: string; score?: number | null; source?: string }
export type MedicineInformation = {
  name: string; generic_name: string; brand_name: string; category: string; what_is_it: string; uses: string
  mechanism: string; side_effects: string
  precautions: { warnings: string; precautions: string; contraindications: string }
  sources: { name: string; url: string }[]; label_available: boolean
}
export type PrescriptionMedicineResult = PrescriptionCandidate & {
  match_status: 'verified' | 'needs_confirmation' | 'unable_to_identify' | 'lookup_unavailable' | 'rejected'
  matches: PrescriptionMedicineMatch[]; medicine: MedicineInformation | null; message: string; confirmed_rxcui?: string
}
export type Notification = { message: string; status: string; at: string }
export type ReminderSettings = {
  initial_minutes: number; followup_minutes: number; escalation_minutes: number
  notify_caretakers: boolean; notify_family: boolean
}
export type AuditItem = { actor_id: number; action: string; at: string }
