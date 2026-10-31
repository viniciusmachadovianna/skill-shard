# entrypoint do FastAPI

# duplicado de client.py p/ testes
import os
from dotenv import load_dotenv
from google import genai

from fastapi import FastAPI
from pydantic import BaseModel

load_dotenv()

api_key = os.getenv("LLM_API_KEY")
llm_model = os.getenv("LLM_MODEL_ID")
client = genai.Client(api_key=api_key)


# pego das doc. oficiais do uvicorn
# async def app(scope, receive, send):
#     assert scope['type'] == 'http'

#     await send({
#         'type': 'http.response.start',
#         'status': 200,
#         'headers': [
#             (b'content-type', b'text/plain'),
#             (b'content-length', b'13'),
#         ],
#     })
#     await send({
#         'type': 'http.response.body',
#         'body': b'Hello, world!',
#     })

class AskRequest(BaseModel):
    question: str
    
app = FastAPI()
@app.post("/ask")
def ask(request: AskRequest):
    response = client.models.generate_content(
        model=llm_model, contents=request.question
    )
    return response.text