# Contributing to Skill Shard

Project setup and usage are in the [README](README.en.md). This file covers the conventions used when changing the code.

## Commit messages

Format: `[type] short summary in lowercase, imperative mood`

| Type | Use for |
|---|---|
| `[feat]` | New user-visible functionality |
| `[fix]` | Bug fixes |
| `[be]` | Backend changes that fit no other type |
| `[refactor]` | Restructuring with no behavior change |
| `[style]` | Visual or formatting changes (CSS, themes, layout) |
| `[test]` | Adding or changing tests |
| `[docs]` | README, this file, comments |
| `[chore]` | Dependencies, ignore files, tooling |

Use these exact spellings. Older commits also contain `[tests]`, `[refact]`, `[backend]` and `[readme]`; do not copy them.

## Running the tests

The tests use `unittest` and live in `backend/tests/`. Activate the virtual environment, then run from `backend/`:

```
python -m unittest tests.test_ask_documents tests.test_entity_graph tests.test_retrieval
```

These tests mock the Gemini API, so they run offline and use no quota.

`tests/test_llm_client.py` and `tests/test_vector_store.py` are manual scripts, not unit tests. They call the real Gemini API as soon as they are imported, so `unittest discover` will run them and spend quota. Run them one at a time and only when you mean to:

```
python -m tests.test_llm_client
```

Add new tests as `unittest.TestCase` classes and mock every call to Gemini.

## Backend code style

- Follow [PEP 257](https://peps.python.org/pep-0257/) for docstrings: a one-line summary, then details if needed. Modules and public functions get a docstring when their purpose is not obvious from the name.
- Docstrings follow this template (written in Portuguese, like the rest of the project documentation):

  ```python
  """
  Resumo de uma linha do que a função faz.

  Explicação mais detalhada se necessário.

  Args:
      parametro: o que ele representa

  Returns:
      o que a função devolve
  """
  ```

- Comment only when the reason is not obvious from the code: a hidden constraint, a workaround, behavior that would surprise a reader. Do not comment what the code already says.
- Never commit `.env`, API keys, `venv/` or the contents of `backend/data/` (it holds document text and embeddings).

## Frontend conventions

- Plain HTML, CSS and JavaScript modules. No build step.
- Every user-visible string goes through the translation system in `frontend/script/language.js`: use `t('key')` in JavaScript, or the `data-i18n`, `data-i18n-placeholder`, `data-i18n-aria` and `data-i18n-title` attributes in HTML.
- Add each new key to both the `en` and `pt-BR` blocks of `translations`. A key present in only one language shows up untranslated.

## Documentation

The README exists in two languages: [README.md](README.md) (Portuguese) and [README.en.md](README.en.md) (English). Change both in the same commit.

## Adding a supported file type

A new format must be registered in several places:

1. `backend/app/main.py`: add the extension to `SUPPORTED_REPOSITORY_EXTENSIONS` and to the local `supported_extensions` set in `build_document_chunks`. They are two separate copies today.
2. `backend/app/ingestion/`: if the format needs parsing (as PDF does in `loader.py`), add a loader that returns a list of `{"page", "text", "source_file"}` dicts. Plain-text formats are read directly in `build_document_chunks`.
3. `frontend/index.html`: add the extension and MIME type to the `accept` attribute of the file input.
4. Add a test that indexes a small sample of the format.
5. Update the list of supported formats in both READMEs.
