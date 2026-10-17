import logging

from . import models
from . import controllers
from . import wizards

_logger = logging.getLogger(__name__)


def _post_init_hook(env):
    """Called after module install — does nothing special on first install."""
    pass
