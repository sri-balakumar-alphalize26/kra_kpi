{
    "name": "369Chats",
    "version": "1.0",
    "author": "Alphalize",
    "category": "Discuss",
    "summary": "Company WhatsApp-style chat for the mobile app (number-login identity).",
    # Depends on kra_kpi_module for the app-login user fields (kpi_mobile_number,
    # kpi_app_login_enabled), the Expo push-token store (kpi.push.token) and the
    # KRA/KPI role groups. No web assets — this is a pure JSON API for the RN app.
    "depends": ["base", "web", "kra_kpi_module"],

    "data": [
        "security/ir.model.access.csv",
        "security/chats_rules.xml",
        "views/chat_views.xml",
    ],

    "assets": {
        "web.assets_backend": [
            "chats_369/static/src/chat_app/chat_app.js",
            "chats_369/static/src/chat_app/chat_app.scss",
        ],
    },

    "installable": True,
    # Standalone app: shows its own "369Chats" icon in the Apps grid.
    "application": True,
}
