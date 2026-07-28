{
    "name": "KRA/KPI Management",
    "version": "19.0.2.4",
    "author": "Your Company",   
    "category": "Human Resources",
    "summary": "KRA/KPI Master with Custom OWL UI",
    "depends": ["base", "web", "whatsapp_neonize"],

    "data": [
        "security/kra_kpi_groups.xml",
        "security/ir.model.access.csv",
        "security/kpi_security_rules.xml",
        "security/kpi_client_invoice_record_rules.xml",
        "data/kpi_client_invoice_sequence.xml",
        "data/kpi_partial_timeout_cron.xml",
        "data/kpi_admin_accept_cron.xml",
        "data/kpi_pre_approval_escalate_cron.xml",
        "data/kpi_workday_cron.xml",
        "data/kpi_notification_retry_cron.xml",
        "data/kpi_notification_cleanup_cron.xml",
        "data/kpi_snapshot_cleanup_cron.xml",
        "data/kpi_daily_report_cron.xml",
        "data/kpi_queue_nudge_cron.xml",
        "data/kpi_idle_check_cron.xml",
        "data/kpi_urgent_nudge_cron.xml",
        "data/kpi_auto_away_cron.xml",
        "views/wa_approval_templates.xml",
        # Must load BEFORE menu.xml — menu_kra_root references this action.
        "views/kra_welcome_action.xml",
        "views/client_action.xml",
        "views/kpi_action_screen.xml",
        "views/kpi_pair_gate_views.xml",
        "views/kpi_config_screen_views.xml",
        'views/kra_warehouse_views.xml',
        "views/kpi_action_detail.xml",
        "views/task_documents_action.xml",
        "views/kpi_cleanup_views.xml",
        "views/kpi_cleanup_auth_views.xml",
        "views/menu.xml",
        "views/kpi_workflow_views.xml",
        "views/kpi_reports_views.xml",
        "views/kpi_employee_report_views.xml",
        "views/kpi_daily_report_views.xml",
        "views/kpi_reassignment_history_views.xml",
        "views/kpi_backup_views.xml",
        "views/kpi_cleanup_password_action.xml",
        "views/kpi_work_session_views.xml",
        "views/kpi_company_settings_views.xml",
        "views/kpi_configuration_views.xml",
        "views/kpi_user_access_views.xml",
        "views/kpi_task_approval_views.xml",
        # After menu.xml: it defines both its action and a menuitem under
        # menu_kra_root, so the parent must already exist.
        "views/kpi_workday_snapshot_views.xml",
        "views/res_users_views.xml",
    ],

    "assets": {
        "web.assets_backend": [
            # jsPDF Libraries for PDF Export
            "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
            "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js",
            # JSZip for bundling per-project + per-task PDFs into one archive
            "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
            
            # Shared utils
            "kra_kpi_module/static/src/utils/upload_with_progress.js",

            # Existing JS files
            "kra_kpi_module/static/src/js/router.js",
            "kra_kpi_module/static/src/js/main.js",
            # Landing page for the KRA / KPI root menu (see kra_welcome_action.xml).
            "kra_kpi_module/static/src/components/kpi_welcome/kpi_welcome.js",
            "kra_kpi_module/static/src/components/kpi_workday_snapshot/kpi_workday_snapshot.js",
            "kra_kpi_module/static/src/components/dashboard/dashboard.js",
            "kra_kpi_module/static/src/components/kra_tree/kra_tree.js",
            "kra_kpi_module/static/src/components/kra_tree/kra_node.js",
            "kra_kpi_module/static/src/components/kra_create/kra_create.js",
            "kra_kpi_module/static/src/components/kpi_create/kpi_create.js",
            "kra_kpi_module/static/src/components/kpi_view/kpi_view.js",
            "kra_kpi_module/static/src/components/kpi_action/kpi_action.js",
            "kra_kpi_module/static/src/components/kpi_unit_report/kpi_unit_report.js", 
            "kra_kpi_module/static/src/components/kpi_performance_report/kpi_performance_report.js",
            "kra_kpi_module/static/src/components/kpi_attention_report/kpi_attention_report.js",
            "kra_kpi_module/static/src/components/kpi_kra_report/kpi_kra_report.js",
            "kra_kpi_module/static/src/components/kpi_employee_report/kpi_employee_report.js",
            "kra_kpi_module/static/src/components/task_documents/task_documents.js",
            "kra_kpi_module/static/src/components/kpi_client_invoice/kpi_client_invoice.js",
            "kra_kpi_module/static/src/components/kpi_completion_certificate/kpi_completion_certificate.js",
            "kra_kpi_module/static/src/components/kpi_requirements_upload/kpi_requirements_upload.js",
            "kra_kpi_module/static/src/components/kpi_project_completion/kpi_project_completion.js",
            "kra_kpi_module/static/src/components/kpi_client_workspace/kpi_client_workspace.js",
            "kra_kpi_module/static/src/components/kpi_client_dashboard/kpi_client_dashboard.js",
            "kra_kpi_module/static/src/components/kpi_owner_dashboard/kpi_owner_dashboard.js",
            "kra_kpi_module/static/src/components/kpi_client_completions/kpi_client_completions.js",
            "kra_kpi_module/static/src/components/kpi_pending_queue/kpi_pending_queue.js",
            "kra_kpi_module/static/src/components/kpi_developer_summary/kpi_developer_summary.js",
            "kra_kpi_module/static/src/components/kpi_live_tracking/kpi_live_tracking.js",
            "kra_kpi_module/static/src/components/kpi_period_report/kpi_period_report.js",
            "kra_kpi_module/static/src/components/kpi_company_settings/kpi_company_settings.js",
            "kra_kpi_module/static/src/components/kpi_configuration/kpi_configuration.js",
            "kra_kpi_module/static/src/components/kpi_pair_gate/kpi_pair_gate.js",
            "kra_kpi_module/static/src/components/kpi_user_access/kpi_user_access.js",
            "kra_kpi_module/static/src/components/kpi_task_approval/kpi_task_approval.js",

            # (The dashboard/kra_tree/kra_create/kpi_create/kpi_action .xml files are
            #  intentionally NOT bundled: those components use inline `xml\`...\``
            #  templates, so the .xml files are unused. They previously lived in the
            #  removed `web.assets_qweb` bundle and were imported by main.js, which
            #  broke the whole JS bundle in Odoo 17+.)
            "kra_kpi_module/static/src/img/alphalize_logo.png",
            "kra_kpi_module/static/src/css/kra_style.scss",
            "kra_kpi_module/static/src/css/kpi_reports.css",
        ],
    },

    "installable": True,
    "application": True,
    "post_init_hook": "_post_init_client_invoice",
}