from . import kra
from . import kpi
from . import kpi_config_screen
from . import warehouse
from . import kpi_reports
from . import kpi_kra_report
from . import kpi_progress
from . import kpi_user_manual
from . import kpi_reassignment_history
from . import kpi_checklist_guideline_master
from . import kpi_github_link
from . import kpi_backup
from . import kpi_cleanup
from . import kpi_cleanup_password_config
from . import kpi_cleanup_auth
from . import kpi_cleanup_change_password
from . import kpi_employee_report
from . import kpi_time_log
from . import kpi_break_log
from . import kpi_client_invoice
from . import res_users_signature
from . import res_company_kpi
# Advanced Workflow MVP additions
from . import kpi_action_log
from . import whatsapp_config_kpi
from . import kpi_workflow
from . import kpi_notify
from . import kpi_wa_conversation
from . import kpi_inbound_patch
from . import kpi_work_session
from . import kpi_nontask_block
from . import kpi_notification_queue
from . import kpi_notification
from . import kpi_push_token
from . import kpi_pair
from . import kpi_app_otp
from . import kpi_workday_snapshot
from . import kpi_daily_report
from . import whatsapp_group_patch
from . import kpi_wa_group_event
from . import kpi_wa_group_report
from . import kpi_wa_group_capture
from . import kpi_wa_inbound_hook
from . import kpi_file_attachment
from . import kpi_report_download
from . import kpi_ai
from . import kpi_ai_config
from . import kpi_ai_assistant
from . import kpi_wa_group_intake
from . import kpi_server
from . import kpi_install_preset
from . import kpi_decline_reason
from . import kpi_decline
from . import kpi_provisioning
from . import kpi_tz
from . import kpi_db_term
from . import kpi_db_disconnect_reason
# AFTER kpi_provisioning: it adds 'db_disconnect' to that module's
# request_category with selection_add, which needs the base field to exist.
from . import kpi_client_db
from . import kpi_client_db_wizard
from . import kpi_meeting
# LAST of the WhatsApp group: kpi.approval is a SQL view UNIONing kra_kpi,
# kpi_client_db and kpi_meeting, so every one of those tables has to be
# created before its init() runs.
from . import kpi_approval
from . import kpi_wa_database
from . import kpi_manager
# AFTER kpi_manager (it uses _manager_users) and AFTER kpi_wa_conversation,
# whose step Selection it extends.
from . import kpi_manager_dm
# AFTER kpi_meeting and kpi_wa_group_capture: kpi.doubt points at both.
from . import kpi_doubt
# AFTER kpi_wa_group_intake: it inherits that router and imports _strip_emoji.
from . import kpi_wa_staff_menu
from . import kpi_reminder
