# Internet to PSTN Calling System (Live Voice Console)

A web-based telephony application that bridges  internet VoIP and traditional PSTN networks. Built with **React** on the frontend and **FastAPI** on the backend, this system allows you to make phone calls directly from your browser—no SIM card required. 
Powered by **LiveKit** for sub-second latency WebRTC & SIP routing, **Twilio** as the SIP provider for mobile numbers, and **Deepgram** for real-time transcription.

## ✨ Features
* **Browser-to-PSTN Calling**: Dial real phone numbers globally straight from the web dashboard using a Twilio-provisioned mobile number.
* **Real-time Transcription**: Live Speech-to-Text (STT) powered by Deepgram's Nova-2 model, featuring automatic speaker diarization.
* **Audio Recording**: Capture and download high-quality WebM recordings of your active calls.
* **Participant Management**: Mute, unmute, and hang up on participants seamlessly via the backend API.
* **Modern UI**: A responsive, premium "Console" dashboard providing real-time call states, active speaker indicators, and dynamic call controls.

## 🛠️ Architecture
* **Frontend (`client/`)**: React.js, Vite, Vanilla CSS.
* **Backend (`server/`)**: FastAPI, Python, Uvicorn.
* **Infrastructure Services**:
  * **LiveKit Cloud**: Handles WebRTC signaling and SIP Trunks.
  * **Twilio**: Acts as the SIP provider provisioning the phone number to route calls to traditional PSTN mobile towers.
  * **Deepgram**: Handles the WebSocket stream for STT and diarization.

## 🚀 Getting Started
### Prerequisites
* Node.js (v18+)
* Python (3.10+)
* LiveKit Cloud Account + SIP Trunk configured
* Twilio Account with an active phone number + SIP URI configured
* Deepgram API Key

### 1. Set up the Backend
Navigate to the `server` directory, install requirements, and configure your `.env` file.

```bash
cd server
python -m venv .venv

# Windows
.venv\Scripts\activate
# Mac/Linux
source .venv/bin/activate

pip install -r requirements.txt
```

Create a `.env` file in the `server` directory:
```env
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret

# The LiveKit SIP Trunk ID that is connected to your Twilio number
SIP_TRUNK_ID=your_sip_trunk_id

follow the given guide to generate SIP Trunk ID : https://drive.google.com/file/d/1lO9HRuvdpB03v379Y42VOcWSu-RQIzAX/view?usp=sharing 
```

Run the backend:
```bash
uvicorn main:app --reload
```
*The server will start on `http://localhost:8000`*

### 2. Set up the Frontend
Navigate to the `client` directory, install dependencies, and configure your environment.

```bash
cd client
npm install
```

Create a `.env` file in the `client` directory:
```env
VITE_DEEPGRAM_API_KEY=your_deepgram_api_key
```

Start the development server:
```bash
npm run dev
```
*The frontend will start on `http://localhost:5173`*

## 💡 Usage
1. Open the frontend in your browser.
2. Click **Join Room** and grant microphone permissions.
3. Add a participant by entering their country code (e.g., `+91`) and 10-digit phone number.(with free twlio account we must verify that number to make calls)
4. Click **Call** to establish the SIP connection over Twilio.
5. Use **Start Transcript** to begin live Deepgram STT, and **Start Record** to capture local session audio.

