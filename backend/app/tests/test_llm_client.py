# Testing - Open /backend on terminal:
# python -m app.tests.test_llm_client
from app.generation.llm_client import ask_llm

answer = ask_llm("Who are thou?")
print(answer)