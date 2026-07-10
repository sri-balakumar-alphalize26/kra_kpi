-- ================================================================================
-- Goldenspoon Vegetable POS - APK :: task seed
--   * Deletes all existing kra_kpi rows for the project (cascade clears time logs,
--     M2M rel rows, progress, reassignment_history).
--   * Re-inserts every Requirement / Bug Fix task from V01 and V02 with +30 min
--     added to each task's duration.
--   * Auto-assigns Sri Balakumar as primary user_id + developer_ids.
--   * Marks each task admin_approved = TRUE, task_state = 'awaiting_client'
--     (manager partially approved -> awaiting client sign-off).
--
-- Times in screenshot are in IST. We store them as naive UTC (Odoo convention) by
-- subtracting v_tz_offset; change v_tz_offset below if the source is a different TZ.
--
-- Run: psql -U odoo -d <your_db> -f goldenspoon_seed.sql
-- ================================================================================

DO $$
DECLARE
    v_project_id   integer;
    v_dev_uid      integer;
    v_mgr_uid      integer;
    v_tz_offset    interval := INTERVAL '5 hours 30 minutes';  -- IST -> UTC
    v_extra        interval := INTERVAL '30 minutes';
    v_now          timestamp := (NOW() AT TIME ZONE 'UTC');
    v_kpi_id       integer;
    v_inserted     integer  := 0;
    rec            record;
BEGIN
    ----------------------------------------------------------------------------
    -- 1. Lookups
    ----------------------------------------------------------------------------
    SELECT id INTO v_project_id
      FROM kra_master
     WHERE name = 'Goldenspoon Vegetable POS - APK'
     LIMIT 1;

    IF v_project_id IS NULL THEN
        RAISE EXCEPTION
          'Project "Goldenspoon Vegetable POS - APK" not found in kra_master.';
    END IF;

    SELECT u.id INTO v_dev_uid
      FROM res_users u
      JOIN res_partner p ON p.id = u.partner_id
     WHERE p.name ILIKE '%balakumar%' OR u.login ILIKE '%balakumar%'
     ORDER BY u.id
     LIMIT 1;

    IF v_dev_uid IS NULL THEN
        RAISE EXCEPTION
          'Developer "Sri Balakumar" not found in res_users (tried partner.name and login).';
    END IF;

    -- Manager: any user in the KRA/KPI Admin group, prefer someone other than the dev.
    SELECT u.id INTO v_mgr_uid
      FROM res_users u
      JOIN res_groups_users_rel gur ON gur.uid = u.id
      JOIN ir_model_data imd        ON imd.res_id = gur.gid
     WHERE imd.model  = 'res.groups'
       AND imd.module = 'kra_kpi_module'
       AND imd.name   = 'group_kra_admin'
       AND u.id <> v_dev_uid
     ORDER BY u.id
     LIMIT 1;

    -- Fallback to superuser (uid 2) if no KRA Admin found.
    IF v_mgr_uid IS NULL THEN
        v_mgr_uid := 2;
    END IF;

    RAISE NOTICE 'Project id = %, dev uid = %, manager uid = %',
                 v_project_id, v_dev_uid, v_mgr_uid;

    ----------------------------------------------------------------------------
    -- 2. Wipe existing tasks for this project (cascades through child tables)
    ----------------------------------------------------------------------------
    DELETE FROM kra_kpi WHERE kra_id = v_project_id;
    RAISE NOTICE 'Deleted existing kra_kpi rows for project %.', v_project_id;

    ----------------------------------------------------------------------------
    -- 3. Re-insert all tasks
    --    orig_min = duration shown in screenshot (minutes).
    --    Stored estimate = orig_min + 30 (per requirement "add 30 min to each").
    ----------------------------------------------------------------------------
    FOR rec IN
        SELECT *
          FROM (VALUES
              --  idx  version  ext_ref     name                                                                  start (IST)              end (IST)                orig_min
              ( 1,  'V01', 'REQ-001', 'Discount functionality',                                                  TIMESTAMP '2026-05-12 13:00', TIMESTAMP '2026-05-12 15:00', 120),
              ( 2,  'V01', 'REQ-002', 'User privileges',                                                         TIMESTAMP '2026-05-12 15:15', TIMESTAMP '2026-05-12 16:10',  55),
              ( 3,  'V01', 'REQ-003', 'User privilege manager hiding functionality',                             TIMESTAMP '2026-05-13 09:30', TIMESTAMP '2026-05-13 12:00', 150),
              ( 4,  'V01', 'REQ-004', 'User privilege UI and warning banner',                                    TIMESTAMP '2026-05-13 12:30', TIMESTAMP '2026-05-13 13:30',  60),
              ( 5,  'V01', 'REQ-005', 'Location module functionality',                                           TIMESTAMP '2026-05-13 13:30', TIMESTAMP '2026-05-13 15:30', 120),
              ( 6,  'V01', 'BUG-001', 'Invoice size and order details image bug',                                TIMESTAMP '2026-05-13 16:00', TIMESTAMP '2026-05-13 17:00',  60),
              ( 7,  'V01', 'BUG-002', 'Location permission and homepage tile UI bug',                            TIMESTAMP '2026-05-13 17:00', TIMESTAMP '2026-05-13 18:30',  90),
              ( 8,  'V01', 'REQ-006', 'App name and project ID changed',                                         TIMESTAMP '2026-05-13 18:30', TIMESTAMP '2026-05-13 19:30',  60),
              ( 9,  'V01', 'REQ-007', 'Vehicle maintenance module',                                              TIMESTAMP '2026-05-14 12:00', TIMESTAMP '2026-05-14 13:00',  60),
              (10,  'V01', 'REQ-008', 'Device config full functionality',                                        TIMESTAMP '2026-05-14 15:15', TIMESTAMP '2026-05-14 16:15',  60),
              (11,  'V01', 'REQ-009', 'Currency configuration as Odoo',                                          TIMESTAMP '2026-05-14 16:15', TIMESTAMP '2026-05-14 17:00',  45),
              (12,  'V01', 'REQ-010', '3 digit currency format',                                                 TIMESTAMP '2026-05-14 17:00', TIMESTAMP '2026-05-14 17:45',  45),
              (13,  'V01', 'BUG-003', 'Expense receipt attachment, image popup and camera bug',                  TIMESTAMP '2026-05-14 17:45', TIMESTAMP '2026-05-14 18:30',  45),
              (14,  'V01', 'BUG-004', 'Product loading count issue',                                             TIMESTAMP '2026-05-14 18:30', TIMESTAMP '2026-05-14 19:15',  45),
              (15,  'V01', 'BUG-005', 'Currency changing flow fixed',                                            TIMESTAMP '2026-05-14 19:15', TIMESTAMP '2026-05-14 19:45',  30),
              (16,  'V01', 'REQ-011', 'POS invoice currency/company/location popup',                             TIMESTAMP '2026-05-14 19:45', TIMESTAMP '2026-05-14 20:15',  30),
              (17,  'V01', 'BUG-006', 'POS payment speed and cashier chip count fix',                            TIMESTAMP '2026-05-14 20:15', TIMESTAMP '2026-05-14 21:15',  60),
              (18,  'V01', 'BUG-007', 'Expense submit to manager and QR popup issue',                            TIMESTAMP '2026-05-15 12:15', TIMESTAMP '2026-05-15 13:00',  45),
              (19,  'V01', 'REQ-012', 'Register qty typing and bulk delete',                                     TIMESTAMP '2026-05-15 13:25', TIMESTAMP '2026-05-15 14:15',  50),
              (20,  'V01', 'REQ-013', 'Privilege app separate module',                                           TIMESTAMP '2026-05-15 14:15', TIMESTAMP '2026-05-15 16:15', 120),
              (21,  'V01', 'BUG-008', 'POS stock decrement and cart image issue',                                TIMESTAMP '2026-05-15 16:15', TIMESTAMP '2026-05-15 17:00',  45),
              (22,  'V01', 'REQ-014', 'Easy purchase apps',                                                      TIMESTAMP '2026-05-15 17:00', TIMESTAMP '2026-05-15 18:00',  60),
              (23,  'V01', 'BUG-009', 'Easy purchase confirm order and duplicate order issue',                   TIMESTAMP '2026-05-15 18:45', TIMESTAMP '2026-05-15 21:00', 135),
              (24,  'V01', 'REQ-015', 'Home logo, A4/A5 receipt size, POS location fix',                         TIMESTAMP '2026-05-16 10:00', TIMESTAMP '2026-05-16 11:00',  60),
              (25,  'V01', 'REQ-016', 'Credit payment button and partial payment popup',                         TIMESTAMP '2026-05-16 11:00', TIMESTAMP '2026-05-16 12:00',  60),
              (26,  'V01', 'BUG-010', 'POS closing balance popup and sale PDF button',                           TIMESTAMP '2026-05-16 13:15', TIMESTAMP '2026-05-16 14:00',  45),
              (27,  'V01', 'REQ-017', 'POS 3 button menu and return products',                                   TIMESTAMP '2026-05-16 14:00', TIMESTAMP '2026-05-16 15:00',  60),
              (28,  'V01', 'REQ-018', 'POS barcode scanner and session UI',                                      TIMESTAMP '2026-05-16 15:30', TIMESTAMP '2026-05-16 16:30',  60),
              (29,  'V01', 'BUG-011', 'POS UX polish and split payment rename',                                  TIMESTAMP '2026-05-16 16:30', TIMESTAMP '2026-05-16 17:45',  75),
              (30,  'V01', 'REQ-019', 'Quick purchase return added',                                             TIMESTAMP '2026-05-16 18:30', TIMESTAMP '2026-05-16 19:00',  30),
              (31,  'V01', 'REQ-020', 'Purchase return functionality',                                           TIMESTAMP '2026-05-16 19:00', TIMESTAMP '2026-05-16 19:35',  35),

              (32,  'V02', 'BUG-012', 'Attendance config fixing',                                                TIMESTAMP '2026-05-18 10:00', TIMESTAMP '2026-05-18 11:30',  90),
              (33,  'V02', 'REQ-021', 'Orders and inventory polish',                                             TIMESTAMP '2026-05-18 11:30', TIMESTAMP '2026-05-18 13:00',  90),
              (34,  'V02', 'BUG-013', 'Invoice decimals and note keyboard issue',                                TIMESTAMP '2026-05-18 13:00', TIMESTAMP '2026-05-18 14:00',  60),
              (35,  'V02', 'BUG-014', 'Multi DB POS split modal fixes',                                          TIMESTAMP '2026-05-18 14:00', TIMESTAMP '2026-05-18 14:45',  45),
              (36,  'V02', 'BUG-015', 'Return product functionality fix',                                        TIMESTAMP '2026-05-18 14:45', TIMESTAMP '2026-05-18 15:15',  30),
              (37,  'V02', 'REQ-022', 'Sales report filtration and UI',                                          TIMESTAMP '2026-05-18 15:45', TIMESTAMP '2026-05-18 17:45', 120),
              (38,  'V02', 'REQ-023', 'QR invoice PDF buttons and POS scan config',                              TIMESTAMP '2026-05-18 15:45', TIMESTAMP '2026-05-18 17:45', 120),
              (39,  'V02', 'REQ-024', 'Privilege gates and QR UI',                                               TIMESTAMP '2026-05-18 17:45', TIMESTAMP '2026-05-18 19:00',  75),
              (40,  'V02', 'REQ-025', 'Expense payment method',                                                  TIMESTAMP '2026-05-19 10:00', TIMESTAMP '2026-05-19 10:50',  50),
              (41,  'V02', 'REQ-026', 'Expense PDF and Excel button',                                            TIMESTAMP '2026-05-19 12:10', TIMESTAMP '2026-05-19 13:40',  90),
              (42,  'V02', 'REQ-027', 'Expense date range filtration',                                           TIMESTAMP '2026-05-19 13:40', TIMESTAMP '2026-05-19 14:00',  20),
              (43,  'V02', 'BUG-016', 'POS close register and popup styling',                                    TIMESTAMP '2026-05-19 14:00', TIMESTAMP '2026-05-19 15:15',  75),
              (44,  'V02', 'REQ-028', 'Tax checkbox and tax functionality',                                      TIMESTAMP '2026-05-19 16:00', TIMESTAMP '2026-05-19 17:00',  60),
              (45,  'V02', 'REQ-029', 'Tax details button in invoice',                                           TIMESTAMP '2026-05-19 17:00', TIMESTAMP '2026-05-19 17:30',  30),
              (46,  'V02', 'REQ-030', 'Customer mandatory in credit invoice',                                    TIMESTAMP '2026-05-19 17:30', TIMESTAMP '2026-05-19 17:50',  20),
              (47,  'V02', 'REQ-031', 'Partial payment card and cash inside credit',                             TIMESTAMP '2026-05-19 17:50', TIMESTAMP '2026-05-19 18:15',  25),
              (48,  'V02', 'REQ-032', 'Orders store in accounting invoices',                                     TIMESTAMP '2026-05-19 18:15', TIMESTAMP '2026-05-19 20:00', 105),
              (49,  'V02', 'REQ-033', 'Accounting invoices and journal entries',                                 TIMESTAMP '2026-05-19 18:50', TIMESTAMP '2026-05-19 19:15',  25),
              (50,  'V02', 'BUG-017', 'Cash/card change amount and invoice notes',                               TIMESTAMP '2026-05-19 20:00', TIMESTAMP '2026-05-19 20:50',  50),
              (51,  'V02', 'REQ-034', 'On hand qty while creating product',                                      TIMESTAMP '2026-05-19 20:50', TIMESTAMP '2026-05-19 21:10',  20),
              (52,  'V02', 'BUG-018', 'User data fetch JSON RPC',                                                TIMESTAMP '2026-05-19 21:10', TIMESTAMP '2026-05-19 21:28',  18),
              (53,  'V02', 'REQ-035', 'Partner ledger and reports UI',                                           TIMESTAMP '2026-05-19 21:28', TIMESTAMP '2026-05-19 22:40',  72),
              (54,  'V02', 'REQ-036', 'Journals list and details',                                               TIMESTAMP '2026-05-19 22:40', TIMESTAMP '2026-05-19 23:30',  50),
              (55,  'V02', 'REQ-037', 'Invoice PDF and reset to draft',                                          TIMESTAMP '2026-05-19 23:30', TIMESTAMP '2026-05-20 01:15', 105),
              (56,  'V02', 'REQ-038', 'Privilege options and app privilege module',                              TIMESTAMP '2026-05-20 01:15', TIMESTAMP '2026-05-20 01:30',  15)
          ) AS t(idx, version, ext_ref, task_name, start_ts_ist, end_ts_ist, orig_min)
         ORDER BY idx
    LOOP
        ------------------------------------------------------------------
        -- Compute adjusted duration = original + 30 minutes
        ------------------------------------------------------------------
        DECLARE
            adj_total_min  integer := rec.orig_min + 30;
            adj_hours      integer := (rec.orig_min + 30) / 60;
            adj_minutes    integer := (rec.orig_min + 30) % 60;
            start_utc      timestamp := rec.start_ts_ist - v_tz_offset;
            end_utc        timestamp := (rec.end_ts_ist + v_extra) - v_tz_offset;
        BEGIN
            INSERT INTO kra_kpi (
                name, kra_id, user_id,
                delivery_version, external_ref,
                estimate_hours, estimate_minutes,
                client_quoted_hours, client_quoted_minutes,
                timer_total_seconds,
                priority, task_state,
                admin_approved, admin_approved_by, admin_approved_date,
                completed_by, completion_date,
                employee_checklist_github, employee_checklist_deployed,
                employee_checklist_manual,  employee_checklist_docs, employee_checklist_tested,
                manager_checklist_reviewed, manager_checklist_manual_reviewed,
                manager_checklist_testing,  manager_checklist_github,
                manager_checklist_tested_success, manager_checklist_docs_approved,
                auto_assign, active, published,
                create_uid, create_date, write_uid, write_date
            ) VALUES (
                rec.task_name, v_project_id, v_dev_uid,
                rec.version, rec.ext_ref,
                adj_hours, adj_minutes,
                adj_hours, adj_minutes,
                adj_total_min * 60.0,
                'regular', 'awaiting_client',
                TRUE, v_mgr_uid, v_now,
                v_dev_uid, end_utc,
                TRUE, TRUE, TRUE, TRUE, TRUE,
                TRUE, TRUE, TRUE, TRUE, TRUE, TRUE,
                TRUE, TRUE, TRUE,
                v_dev_uid, v_now, v_mgr_uid, v_now
            )
            RETURNING id INTO v_kpi_id;

            -- Time log row matching the (extended) work window.
            INSERT INTO kpi_time_log (
                kpi_id, user_id, start_time, end_time, is_active,
                create_uid, create_date, write_uid, write_date
            ) VALUES (
                v_kpi_id, v_dev_uid, start_utc, end_utc, FALSE,
                v_dev_uid, v_now, v_dev_uid, v_now
            );

            -- Role-based developer link (kra_kpi_developer_rel).
            INSERT INTO kra_kpi_developer_rel (kpi_id, user_id)
                 VALUES (v_kpi_id, v_dev_uid);

            -- Contributor link (effective_contributor_ids union).
            INSERT INTO kra_kpi_contributor_rel (kpi_id, user_id)
                 VALUES (v_kpi_id, v_dev_uid)
            ON CONFLICT DO NOTHING;

            v_inserted := v_inserted + 1;
        END;
    END LOOP;

    RAISE NOTICE 'Inserted % tasks for "Goldenspoon Vegetable POS - APK" (kra_master id %).',
                 v_inserted, v_project_id;
END
$$ LANGUAGE plpgsql;

-- ================================================================================
-- Verification queries (run separately after the script)
-- ================================================================================
-- SELECT delivery_version, external_ref, name,
--        estimate_hours || 'h ' || estimate_minutes || 'm' AS duration,
--        task_state, admin_approved
--   FROM kra_kpi
--  WHERE kra_id = (SELECT id FROM kra_master WHERE name = 'Goldenspoon Vegetable POS - APK')
--  ORDER BY delivery_version, external_ref;
--
-- SELECT COUNT(*) FROM kra_kpi
--  WHERE kra_id = (SELECT id FROM kra_master WHERE name = 'Goldenspoon Vegetable POS - APK');
