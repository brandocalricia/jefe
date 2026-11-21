"""Exception types shared by every part of pagewright."""


class PagewrightError(Exception):
    """Base class: str(error) is the complete message."""


class ContentError(PagewrightError):
    """A page or config file is malformed."""


class TemplateError(PagewrightError):
    """A template has a syntax error or refers to something that does not exist."""


class SiteError(PagewrightError):
    """The site folder as a whole is unusable."""
