import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

api_key = os.getenv("LLM_API_KEY")
llm_model = os.getenv("LLM_MODEL_ID")
client = genai.Client(api_key=api_key)

response = client.models.generate_content(
    model=llm_model, contents='Who are you?'
)
print(response.text)