CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  student_no VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  class_name VARCHAR(120) NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  role VARCHAR(16) NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT -1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS grade SMALLINT CHECK (grade IN (1,2));
CREATE TABLE IF NOT EXISTS password_recovery_codes (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  teacher VARCHAR(120) NOT NULL DEFAULT '',
  location VARCHAR(160) NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  enrolled_count INTEGER NOT NULL DEFAULT 0 CHECK (enrolled_count >= 0 AND enrolled_count <= capacity),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE courses ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS grade SMALLINT CHECK (grade IN (1,2));
ALTER TABLE courses ADD COLUMN IF NOT EXISTS online_registration BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE courses SET online_registration=FALSE WHERE name='线下体验课';

CREATE TABLE IF NOT EXISTS enrollments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id),
  course_id BIGINT NOT NULL REFERENCES courses(id),
  idempotency_key VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS enrollments_course_idx ON enrollments(course_id);
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS client_sent_at_ms BIGINT;
UPDATE enrollments SET client_sent_at_ms=(EXTRACT(EPOCH FROM created_at)*1000)::bigint WHERE client_sent_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS course_seats (
  course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  seat_no INTEGER NOT NULL CHECK (seat_no > 0),
  user_id BIGINT UNIQUE REFERENCES users(id),
  PRIMARY KEY(course_id, seat_no)
);
CREATE INDEX IF NOT EXISTS course_seats_available_idx ON course_seats(course_id, seat_no) WHERE user_id IS NULL;
INSERT INTO course_seats(course_id,seat_no)
SELECT c.id,g.seat_no FROM courses c CROSS JOIN LATERAL generate_series(1,c.capacity) g(seat_no)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
UPDATE sessions SET expires_at=LEAST(expires_at,created_at+INTERVAL '2 hours') WHERE expires_at>created_at+INTERVAL '2 hours';
DELETE FROM sessions WHERE expires_at<=NOW();
WITH ranked AS (SELECT token_hash,ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY created_at DESC,token_hash) n FROM sessions)
DELETE FROM sessions USING ranked WHERE sessions.token_hash=ranked.token_hash AND ranked.n>1;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_per_user_idx ON sessions(user_id);

CREATE SEQUENCE IF NOT EXISTS enrollment_jobs_arrival_order_seq;
CREATE TABLE IF NOT EXISTS enrollment_jobs (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id BIGINT NOT NULL REFERENCES courses(id),
  idempotency_key VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  result_enrollment_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  client_sent_at_ms BIGINT,
  arrival_order BIGINT NOT NULL DEFAULT nextval('enrollment_jobs_arrival_order_seq'),
  margin_ms INTEGER,
  UNIQUE(user_id,idempotency_key)
);
ALTER TABLE enrollment_jobs ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp();
ALTER TABLE enrollment_jobs ADD COLUMN IF NOT EXISTS client_sent_at_ms BIGINT;
ALTER TABLE enrollment_jobs ADD COLUMN IF NOT EXISTS arrival_order BIGINT DEFAULT nextval('enrollment_jobs_arrival_order_seq');
UPDATE enrollment_jobs SET arrival_order=nextval('enrollment_jobs_arrival_order_seq') WHERE arrival_order IS NULL;
ALTER TABLE enrollment_jobs ALTER COLUMN arrival_order SET NOT NULL;
ALTER TABLE enrollment_jobs ADD COLUMN IF NOT EXISTS margin_ms INTEGER;
ALTER TABLE enrollment_jobs ADD COLUMN IF NOT EXISTS last_accepted_at_ms BIGINT;
ALTER TABLE enrollment_jobs ALTER COLUMN status TYPE VARCHAR(32);
UPDATE enrollment_jobs SET client_sent_at_ms=(EXTRACT(EPOCH FROM received_at)*1000)::bigint WHERE client_sent_at_ms IS NULL;
WITH ranked AS (SELECT id,ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY received_at,arrival_order) n FROM enrollment_jobs WHERE status='PENDING')
UPDATE enrollment_jobs SET status='CANCELLED',processed_at=NOW() FROM ranked WHERE enrollment_jobs.id=ranked.id AND ranked.n>1;
CREATE UNIQUE INDEX IF NOT EXISTS enrollment_jobs_one_pending_user_idx ON enrollment_jobs(user_id) WHERE status='PENDING';
CREATE INDEX IF NOT EXISTS enrollment_jobs_course_queue_idx ON enrollment_jobs(course_id,client_sent_at_ms) WHERE status='PENDING';
CREATE INDEX IF NOT EXISTS enrollment_jobs_pending_idx ON enrollment_jobs(created_at,id) WHERE status='PENDING';
CREATE INDEX IF NOT EXISTS enrollment_jobs_received_idx ON enrollment_jobs(received_at,id) WHERE status='PENDING';
CREATE INDEX IF NOT EXISTS enrollment_jobs_arrival_idx ON enrollment_jobs(received_at,arrival_order) WHERE status='PENDING';

CREATE TABLE IF NOT EXISTS selection_period (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  state VARCHAR(16) NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'READY', 'OPEN', 'CLOSED')),
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO selection_period(singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES users(id),
  action VARCHAR(80) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION attempt_enrollment(p_user_id BIGINT, p_course_id BIGINT, p_idempotency_key VARCHAR)
RETURNS TABLE(result_status TEXT, result_enrollment_id BIGINT, result_created_at TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE
  v_existing enrollments%ROWTYPE;
  v_seat_no INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(6754001);
  IF NOT EXISTS (SELECT 1 FROM users WHERE id=p_user_id AND role='student' AND enabled AND deleted_at IS NULL) THEN
    RETURN QUERY SELECT 'ACCOUNT_UNAVAILABLE'::TEXT, NULL::BIGINT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  SELECT * INTO v_existing FROM enrollments WHERE user_id=p_user_id;
  IF FOUND THEN
    RETURN QUERY SELECT CASE WHEN v_existing.course_id=p_course_id THEN 'IDEMPOTENT' ELSE 'ALREADY' END,
      v_existing.id,v_existing.created_at;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM courses WHERE id=p_course_id AND enabled) THEN
    RETURN QUERY SELECT 'COURSE_DISABLED'::TEXT, NULL::BIGINT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM courses WHERE id=p_course_id AND (NOT online_registration OR name='线下体验课')) THEN
    RETURN QUERY SELECT 'OFFLINE_ONLY'::TEXT, NULL::BIGINT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM courses c JOIN users u ON u.grade=c.grade WHERE c.id=p_course_id AND u.id=p_user_id) THEN
    RETURN QUERY SELECT 'GRADE_MISMATCH'::TEXT, NULL::BIGINT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  BEGIN
    WITH available AS (
      SELECT course_id,seat_no FROM course_seats
       WHERE course_id=p_course_id AND user_id IS NULL
       ORDER BY seat_no FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE course_seats s SET user_id=p_user_id
      FROM available a
     WHERE s.course_id=a.course_id AND s.seat_no=a.seat_no
    RETURNING s.seat_no INTO v_seat_no;

    IF v_seat_no IS NULL THEN
      IF EXISTS(SELECT 1 FROM courses WHERE id=p_course_id) THEN
        RETURN QUERY SELECT 'FULL'::TEXT,NULL::BIGINT,NULL::TIMESTAMPTZ;
      ELSE
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT,NULL::BIGINT,NULL::TIMESTAMPTZ;
      END IF;
      RETURN;
    END IF;

    INSERT INTO enrollments(user_id,course_id,idempotency_key)
    VALUES(p_user_id,p_course_id,p_idempotency_key)
    RETURNING id,created_at INTO result_enrollment_id,result_created_at;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM enrollments WHERE user_id=p_user_id;
    RETURN QUERY SELECT 'ALREADY'::TEXT,v_existing.id,v_existing.created_at;
    RETURN;
  END;

  INSERT INTO audit_logs(actor_id,action,details)
  VALUES(p_user_id,'ENROLL',jsonb_build_object('courseId',p_course_id));
  result_status := 'SUCCESS';
  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION process_enrollment_batch()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_job RECORD;
  v_result RECORD;
  v_cutoff BIGINT;
  v_count INTEGER := 0;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(6754001);
  IF NOT pg_try_advisory_xact_lock(6754002) THEN RETURN 0; END IF;
  FOR v_job IN SELECT * FROM enrollment_jobs WHERE status='PENDING'
    ORDER BY course_id,client_sent_at_ms,random() LIMIT 2000 FOR UPDATE SKIP LOCKED
  LOOP
    SELECT * INTO v_result FROM attempt_enrollment(v_job.user_id,v_job.course_id,v_job.idempotency_key);
    IF v_result.result_status='SUCCESS' THEN
      UPDATE enrollments SET client_sent_at_ms=v_job.client_sent_at_ms WHERE id=v_result.result_enrollment_id;
    END IF;
    v_cutoff := NULL;
    IF v_result.result_status='FULL' THEN
      SELECT MAX(client_sent_at_ms) INTO v_cutoff FROM enrollments WHERE course_id=v_job.course_id;
    END IF;
    UPDATE enrollment_jobs SET status=v_result.result_status,result_enrollment_id=v_result.result_enrollment_id,
      last_accepted_at_ms=v_cutoff,processed_at=clock_timestamp(),margin_ms=NULL WHERE id=v_job.id;
    v_count := v_count+1;
  END LOOP;
  RETURN v_count;
END $$;
