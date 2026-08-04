# One image that runs the Node ticker AND the Python/OCR score pipeline.
# Railway auto-detects this Dockerfile and uses it instead of the default builder.
FROM node:20-bookworm-slim

# System tools the score reader needs: ffmpeg (frame grab), tesseract (OCR), python.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
      ffmpeg \
      tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

# Python libraries for the CV/OCR pipeline + streamlink to pull Twitch frames.
# headless OpenCV avoids GUI system deps that aren't in a slim image.
RUN pip3 install --no-cache-dir --break-system-packages \
      opencv-python-headless \
      pytesseract \
      pillow \
      numpy \
      streamlink

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=3000
CMD ["node", "server.js"]
