# Skill Visibility

Skillzero hides installed skills from implicit model selection and optionally makes them discoverable through generated collection skills.

## Language

**Managed skill**:
A skill whose implicit model invocation is disabled by skillzero.

**Hidden skill**:
A managed skill that belongs to no collection and remains available only through manual invocation.
_Avoid_: Delete, uninstall

**Collection-visible skill**:
A managed skill that belongs to at least one collection and can be rediscovered through its generated collection skill.
_Avoid_: Indexed skill, index mode

**Collection**:
A routing group that exposes one generated skill for its member skills.
