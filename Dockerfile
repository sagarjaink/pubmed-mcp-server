FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir fastmcp httpx pydantic
ENV PYTHONUNBUFFERED=1
CMD ["python", "main.py"]
