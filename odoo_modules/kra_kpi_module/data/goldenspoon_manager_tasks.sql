-- ================================================================================
-- Goldenspoon Vegetable POS - APK :: Karthick (manager) daily tasks
--
-- Karthick is the manager.  For every date 12/05 .. 20/05 (9 days) he gets THREE
-- tasks:
--
--   1. Review:  Karthick reviews a randomly-picked dev task from THAT day.
--               Name = 'Review: <random dev task name> (DD/MM)'.  Duration 3 h.
--   2. Testing: Karthick tests a different random dev task from that day.
--               Name = 'Testing: <random dev task name> (DD/MM)'. Duration 3 h.
--   3. Meeting: 'Server update meeting with Athul (DD/MM)'. Random duration 1..3 h.
--
-- "Athul" is encoded in the task name only (no user record is created).
-- If a date has no dev tasks (e.g. 17/05) the nearest day's task name is used.
-- All Karthick tasks are admin_approved = TRUE, task_state = 'awaiting_client'.
--
-- Idempotent: deletes all prior Karthick tasks (and any stray REV-/TST-/SUP-/MTG-
-- refs) for this project before inserting.
-- ================================================================================

DO $$
DECLARE
    v_project_id    integer;
    v_karthick      integer;
    v_mgr_uid       integer;
    v_tz_offset     interval := INTERVAL '5 hours 30 minutes';
    v_now           timestamp := (NOW() AT TIME ZONE 'UTC');
    d               date;
    v_idx           integer := 0;
    v_version       text;
    v_kpi_id        integer;
    v_review_name   text;
    v_testing_name  text;
    v_day_total_min integer;
    v_rev_min       integer;
    v_tst_min       integer;
    v_mtg_min       integer;
    v_meet_hr_start integer;
    v_start_ist     timestamp;
    v_end_ist       timestamp;
    v_start_utc     timestamp;
    v_end_utc       timestamp;
    v_idx_normal    integer := 0;   -- counter for REV/TST/MTG
    v_idx_apk       integer := 0;   -- counter for APK series
    v_leave_dates   date[] := ARRAY[DATE '2026-05-17'];
    v_apk_dates     date[] := ARRAY[DATE '2026-05-15', DATE '2026-05-16', DATE '2026-05-20'];
BEGIN
    ----------------------------------------------------------------------------
    -- Lookups
    ----------------------------------------------------------------------------
    SELECT id INTO v_project_id FROM kra_master
     WHERE name = 'Goldenspoon Vegetable POS - APK' LIMIT 1;
    IF v_project_id IS NULL THEN
        RAISE EXCEPTION 'Project "Goldenspoon Vegetable POS - APK" not found.';
    END IF;

    SELECT id INTO v_karthick FROM res_users
     WHERE login ILIKE '%karthick%' LIMIT 1;
    IF v_karthick IS NULL THEN
        RAISE EXCEPTION 'User Karthick not found.';
    END IF;

    SELECT u.id INTO v_mgr_uid
      FROM res_users u
      JOIN res_groups_users_rel gur ON gur.uid = u.id
      JOIN ir_model_data imd        ON imd.res_id = gur.gid
     WHERE imd.model = 'res.groups' AND imd.module = 'kra_kpi_module'
       AND imd.name  = 'group_kra_admin' AND u.id <> v_karthick
     ORDER BY u.id LIMIT 1;
    IF v_mgr_uid IS NULL THEN v_mgr_uid := 2; END IF;

    ----------------------------------------------------------------------------
    -- Wipe prior Karthick tasks for this project (idempotent).
    ----------------------------------------------------------------------------
    DELETE FROM kra_kpi
     WHERE kra_id = v_project_id
       AND (user_id = v_karthick
            OR external_ref LIKE 'REV-%' OR external_ref LIKE 'TST-%'
            OR external_ref LIKE 'SUP-%' OR external_ref LIKE 'MTG-%'
            OR external_ref LIKE 'APK-%');

    PERFORM setseed(0.61);

    FOR d IN
        SELECT generate_series(DATE '2026-05-12', DATE '2026-05-20', INTERVAL '1 day')::date
    LOOP
        -- Skip leave days (e.g. 17/05).
        IF d = ANY (v_leave_dates) THEN
            CONTINUE;
        END IF;

        v_version := CASE WHEN d <= DATE '2026-05-17' THEN 'V01' ELSE 'V02' END;

        ------------------------------------------------------------------------
        -- APK-review days (15, 16, 20): ONLY a single 3 h 'Review APK
        -- Goldenspoon' task — no review/testing/meeting split.
        ------------------------------------------------------------------------
        IF d = ANY (v_apk_dates) THEN
            v_idx_apk   := v_idx_apk + 1;
            v_start_ist := d + TIME '09:00:00';
            v_end_ist   := d + TIME '12:00:00';
            v_start_utc := v_start_ist - v_tz_offset;
            v_end_utc   := v_end_ist   - v_tz_offset;

            INSERT INTO kra_kpi (
                name, kra_id, user_id, delivery_version, external_ref,
                estimate_hours, estimate_minutes,
                client_quoted_hours, client_quoted_minutes,
                timer_total_seconds, priority, task_state,
                admin_approved, admin_approved_by, admin_approved_date,
                completed_by, completion_date,
                employee_checklist_github, employee_checklist_deployed,
                employee_checklist_manual, employee_checklist_docs, employee_checklist_tested,
                manager_checklist_reviewed, manager_checklist_manual_reviewed,
                manager_checklist_testing, manager_checklist_github,
                manager_checklist_tested_success, manager_checklist_docs_approved,
                auto_assign, active, published, is_manager_review_needed,
                create_uid, create_date, write_uid, write_date
            ) VALUES (
                'Review APK Goldenspoon (' || to_char(d, 'DD/MM') || ')',
                v_project_id, v_karthick, v_version,
                'APK-' || lpad(v_idx_apk::text, 3, '0'),
                3, 0, 3, 0, 3 * 3600.0, 'important', 'awaiting_client',
                TRUE, v_mgr_uid, v_now,
                v_karthick, v_end_utc,
                TRUE, TRUE, TRUE, TRUE, TRUE,
                TRUE, TRUE, TRUE, TRUE, TRUE, TRUE,
                TRUE, TRUE, TRUE, TRUE,
                v_karthick, v_now, v_mgr_uid, v_now
            ) RETURNING id INTO v_kpi_id;

            INSERT INTO kpi_time_log (kpi_id, user_id, start_time, end_time, is_active,
                                      create_uid, create_date, write_uid, write_date)
            VALUES (v_kpi_id, v_karthick, v_start_utc, v_end_utc, FALSE,
                    v_karthick, v_now, v_karthick, v_now);
            INSERT INTO kra_kpi_developer_rel  (kpi_id, user_id) VALUES (v_kpi_id, v_karthick);
            INSERT INTO kra_kpi_contributor_rel(kpi_id, user_id) VALUES (v_kpi_id, v_karthick)
                ON CONFLICT DO NOTHING;
            INSERT INTO kra_kpi_lead_rel       (kpi_id, user_id) VALUES (v_kpi_id, v_karthick)
                ON CONFLICT DO NOTHING;
            CONTINUE;
        END IF;

        ------------------------------------------------------------------------
        -- Regular manager days: review + testing + meeting, total 1.5–3 h.
        ------------------------------------------------------------------------
        v_idx_normal := v_idx_normal + 1;
        v_idx        := v_idx_normal;  -- reuse the existing v_idx variable for ref-numbering below

        ------------------------------------------------------------------------
        -- Pick a random Sri-Balakumar task name FROM that calendar day (IST).
        -- IST date is derived from completion_date (which is stored as UTC).
        ------------------------------------------------------------------------
        SELECT k.name INTO v_review_name
          FROM kra_kpi k
         WHERE k.kra_id  = v_project_id
           AND k.user_id <> v_karthick
           AND (k.completion_date + v_tz_offset)::date = d
         ORDER BY random()
         LIMIT 1;

        -- Fallback: no dev task that day (e.g. 17/05) → pick nearest day.
        IF v_review_name IS NULL THEN
            SELECT k.name INTO v_review_name
              FROM kra_kpi k
             WHERE k.kra_id  = v_project_id
               AND k.user_id <> v_karthick
             ORDER BY ABS(((k.completion_date + v_tz_offset)::date - d)::int),
                      random()
             LIMIT 1;
        END IF;

        -- Pick a DIFFERENT task name for testing.
        SELECT k.name INTO v_testing_name
          FROM kra_kpi k
         WHERE k.kra_id  = v_project_id
           AND k.user_id <> v_karthick
           AND (k.completion_date + v_tz_offset)::date = d
           AND k.name <> v_review_name
         ORDER BY random()
         LIMIT 1;

        IF v_testing_name IS NULL THEN
            SELECT k.name INTO v_testing_name
              FROM kra_kpi k
             WHERE k.kra_id  = v_project_id
               AND k.user_id <> v_karthick
               AND k.name   <> v_review_name
             ORDER BY ABS(((k.completion_date + v_tz_offset)::date - d)::int),
                      random()
             LIMIT 1;
        END IF;

        -- Final fallback (only fires if the dev seed is missing entirely).
        IF v_review_name  IS NULL THEN v_review_name  := 'APK build verification'; END IF;
        IF v_testing_name IS NULL THEN v_testing_name := 'APK regression sweep';   END IF;

        ------------------------------------------------------------------------
        -- Per-day total time = 90..180 min (1.5h..3h), split evenly across
        -- the 3 manager tasks. Remainder goes to the meeting bucket.
        ------------------------------------------------------------------------
        v_day_total_min := 90 + floor(random() * 91)::int;   -- 90..180 inclusive
        v_rev_min       := v_day_total_min / 3;
        v_tst_min       := v_day_total_min / 3;
        v_mtg_min       := v_day_total_min - v_rev_min - v_tst_min;

        ------------------------------------------------------------------------
        -- 1. Review task — 09:00 IST start, duration v_rev_min
        ------------------------------------------------------------------------
        v_start_ist := d + TIME '09:00:00';
        v_end_ist   := v_start_ist + make_interval(mins => v_rev_min);
        v_start_utc := v_start_ist - v_tz_offset;
        v_end_utc   := v_end_ist   - v_tz_offset;

        INSERT INTO kra_kpi (
            name, kra_id, user_id, delivery_version, external_ref,
            estimate_hours, estimate_minutes,
            client_quoted_hours, client_quoted_minutes,
            timer_total_seconds, priority, task_state,
            admin_approved, admin_approved_by, admin_approved_date,
            completed_by, completion_date,
            employee_checklist_github, employee_checklist_deployed,
            employee_checklist_manual, employee_checklist_docs, employee_checklist_tested,
            manager_checklist_reviewed, manager_checklist_manual_reviewed,
            manager_checklist_testing, manager_checklist_github,
            manager_checklist_tested_success, manager_checklist_docs_approved,
            auto_assign, active, published, is_manager_review_needed,
            create_uid, create_date, write_uid, write_date
        ) VALUES (
            'Review: ' || v_review_name || ' (' || to_char(d, 'DD/MM') || ')',
            v_project_id, v_karthick, v_version,
            'REV-' || lpad(v_idx::text, 3, '0'),
            v_rev_min / 60, v_rev_min % 60,
            v_rev_min / 60, v_rev_min % 60,
            v_rev_min * 60.0, 'important', 'awaiting_client',
            TRUE, v_mgr_uid, v_now,
            v_karthick, v_end_utc,
            TRUE, TRUE, TRUE, TRUE, TRUE,
            TRUE, TRUE, TRUE, TRUE, TRUE, TRUE,
            TRUE, TRUE, TRUE, TRUE,
            v_karthick, v_now, v_mgr_uid, v_now
        ) RETURNING id INTO v_kpi_id;

        INSERT INTO kpi_time_log (kpi_id, user_id, start_time, end_time, is_active,
                                  create_uid, create_date, write_uid, write_date)
        VALUES (v_kpi_id, v_karthick, v_start_utc, v_end_utc, FALSE,
                v_karthick, v_now, v_karthick, v_now);
        INSERT INTO kra_kpi_developer_rel  (kpi_id, user_id) VALUES (v_kpi_id, v_karthick);
        INSERT INTO kra_kpi_contributor_rel(kpi_id, user_id) VALUES (v_kpi_id, v_karthick)
            ON CONFLICT DO NOTHING;
        INSERT INTO kra_kpi_lead_rel       (kpi_id, user_id) VALUES (v_kpi_id, v_karthick)
            ON CONFLICT DO NOTHING;

        ------------------------------------------------------------------------
        -- 2. Testing task — 13:00 IST start, duration v_tst_min
        ------------------------------------------------------------------------
        v_start_ist := d + TIME '13:00:00';
        v_end_ist   := v_start_ist + make_interval(mins => v_tst_min);
        v_start_utc := v_start_ist - v_tz_offset;
        v_end_utc   := v_end_ist   - v_tz_offset;

        INSERT INTO kra_kpi (
            name, kra_id, user_id, delivery_version, external_ref,
            estimate_hours, estimate_minutes,
            client_quoted_hours, client_quoted_minutes,
            timer_total_seconds, priority, task_state,
            admin_approved, admin_approved_by, admin_approved_date,
            completed_by, completion_date,
            employee_checklist_github, employee_checklist_deployed,
            employee_checklist_manual, employee_checklist_docs, employee_checklist_tested,
            manager_checklist_reviewed, manager_checklist_manual_reviewed,
            manager_checklist_testing, manager_checklist_github,
            manager_checklist_tested_success, manager_checklist_docs_approved,
            auto_assign, active, published, is_manager_review_needed,
            create_uid, create_date, write_uid, write_date
        ) VALUES (
            'Testing: ' || v_testing_name || ' (' || to_char(d, 'DD/MM') || ')',
            v_project_id, v_karthick, v_version,
            'TST-' || lpad(v_idx::text, 3, '0'),
            v_tst_min / 60, v_tst_min % 60,
            v_tst_min / 60, v_tst_min % 60,
            v_tst_min * 60.0, 'important', 'awaiting_client',
            TRUE, v_mgr_uid, v_now,
            v_karthick, v_end_utc,
            TRUE, TRUE, TRUE, TRUE, TRUE,
            TRUE, TRUE, TRUE, TRUE, TRUE, TRUE,
            TRUE, TRUE, TRUE, TRUE,
            v_karthick, v_now, v_mgr_uid, v_now
        ) RETURNING id INTO v_kpi_id;

        INSERT INTO kpi_time_log (kpi_id, user_id, start_time, end_time, is_active,
                                  create_uid, create_date, write_uid, write_date)
        VALUES (v_kpi_id, v_karthick, v_start_utc, v_end_utc, FALSE,
                v_karthick, v_now, v_karthick, v_now);
        INSERT INTO kra_kpi_developer_rel  (kpi_id, user_id) VALUES (v_kpi_id, v_karthick);
        INSERT INTO kra_kpi_contributor_rel(kpi_id, user_id) VALUES (v_kpi_id, v_karthick)
            ON CONFLICT DO NOTHING;
        INSERT INTO kra_kpi_tester_rel     (kpi_id, user_id) VALUES (v_kpi_id, v_karthick)
            ON CONFLICT DO NOTHING;

        ------------------------------------------------------------------------
        -- 3. Server update meeting — duration v_mtg_min (the remaining share),
        --    start hour ∈ {19,20,21} IST.
        ------------------------------------------------------------------------
        v_meet_hr_start := 19 + floor(random() * 3)::int;
        v_start_ist     := d + make_time(v_meet_hr_start, 0, 0);
        v_end_ist       := v_start_ist + make_interval(mins => v_mtg_min);
        v_start_utc     := v_start_ist - v_tz_offset;
        v_end_utc       := v_end_ist   - v_tz_offset;

        INSERT INTO kra_kpi (
            name, kra_id, user_id, delivery_version, external_ref,
            estimate_hours, estimate_minutes,
            client_quoted_hours, client_quoted_minutes,
            timer_total_seconds, priority, task_state,
            admin_approved, admin_approved_by, admin_approved_date,
            completed_by, completion_date,
            employee_checklist_github, employee_checklist_deployed,
            employee_checklist_manual, employee_checklist_docs, employee_checklist_tested,
            manager_checklist_reviewed, manager_checklist_manual_reviewed,
            manager_checklist_testing, manager_checklist_github,
            manager_checklist_tested_success, manager_checklist_docs_approved,
            auto_assign, active, published, is_meeting,
            create_uid, create_date, write_uid, write_date
        ) VALUES (
            'Server update meeting (' || to_char(d, 'DD/MM') || ')',
            v_project_id, v_karthick, v_version,
            'MTG-' || lpad(v_idx::text, 3, '0'),
            v_mtg_min / 60, v_mtg_min % 60,
            v_mtg_min / 60, v_mtg_min % 60,
            v_mtg_min * 60.0, 'regular', 'awaiting_client',
            TRUE, v_mgr_uid, v_now,
            v_karthick, v_end_utc,
            TRUE, TRUE, TRUE, TRUE, TRUE,
            TRUE, TRUE, TRUE, TRUE, TRUE, TRUE,
            TRUE, TRUE, TRUE, TRUE,
            v_karthick, v_now, v_mgr_uid, v_now
        ) RETURNING id INTO v_kpi_id;

        INSERT INTO kpi_time_log (kpi_id, user_id, start_time, end_time, is_active,
                                  create_uid, create_date, write_uid, write_date)
        VALUES (v_kpi_id, v_karthick, v_start_utc, v_end_utc, FALSE,
                v_karthick, v_now, v_karthick, v_now);
        INSERT INTO kra_kpi_developer_rel  (kpi_id, user_id) VALUES (v_kpi_id, v_karthick);
        INSERT INTO kra_kpi_contributor_rel(kpi_id, user_id) VALUES (v_kpi_id, v_karthick)
            ON CONFLICT DO NOTHING;
    END LOOP;

    RAISE NOTICE 'Inserted % review + % testing + % meeting + % APK-review tasks for Karthick.',
                 v_idx_normal, v_idx_normal, v_idx_normal, v_idx_apk;
END
$$ LANGUAGE plpgsql;
