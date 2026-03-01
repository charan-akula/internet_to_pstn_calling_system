import os
import uuid
import datetime
from fastapi import FastAPI
from pydantic import BaseModel
from livekit.api import AccessToken, VideoGrants
from livekit import api
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware  # ADD THIS


load_dotenv()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

LIVEKIT_URL = os.getenv("LIVEKIT_URL")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET")
SIP_TRUNK_ID = os.getenv("SIP_TRUNK_ID")


# -----------------------------
# TOKEN (web user joins room)
# -----------------------------
@app.get("/token")
def get_token(identity: str = "web-user"):
    #room = f"caller-space-{uuid.uuid4().hex[:8]}"
    room = "charan2004"
    token = (
        AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(identity)
        .with_ttl(datetime.timedelta(minutes=30))
        .with_grants(
            VideoGrants(
                room_join=True,
                room=room,
                room_create=True,
            )
        )
    )

    return {
        "url": LIVEKIT_URL,
        "token": token.to_jwt(),
        "room": room,
    }


# -----------------------------
# DIAL SIP PARTICIPANTS
# -----------------------------
class DialTarget(BaseModel):
    person_id: str
    name: str
    phone: str

class DialRequest(BaseModel):
    room: str
    targets: list[DialTarget]

@app.post("/dial")
async def dial(req: DialRequest):
    lkapi = api.LiveKitAPI(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)

    try:
        results = []
        for t in req.targets:
            # make identity safe + unique
            safe_id = f"sip-{t.person_id}-{uuid.uuid4().hex[:6]}"

            p = await lkapi.sip.create_sip_participant(
                api.CreateSIPParticipantRequest(
                    room_name=req.room,
                    sip_trunk_id=SIP_TRUNK_ID,
                    sip_call_to=t.phone,
                    participant_identity=safe_id,
                    participant_name=t.name,
                    wait_until_answered=False,
                    krisp_enabled=True,
                )
            )
            results.append({
                "person_id": t.person_id,
                "phone": t.phone,
                "identity": safe_id,
                "participant_id": p.participant_id,
            })

        return {"ok": True, "dialed": results}

    finally:
        await lkapi.aclose()



# @app.get("/participants")
# async def participants(room: str):
#     lkapi = api.LiveKitAPI(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
#     try:
#         resp = await lkapi.room.list_participants(api.ListParticipantsRequest(room=room))
#         # resp.participants = list[ParticipantInfo]
#         out = []
#         for p in resp.participants:
#             out.append({
#                 "identity": p.identity,
#                 "name": p.name,
#                 "state": str(p.state) if hasattr(p, "state") else None,
#             })
#         return {"ok": True, "participants": out}
#     finally:
#         await lkapi.aclose()
# In your main.py / backend file

@app.get("/participants")
async def participants(room: str):
    lkapi = api.LiveKitAPI(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    try:
        resp = await lkapi.room.list_participants(api.ListParticipantsRequest(room=room))
        out = []
        for p in resp.participants:
            # Safely get the call status from attributes, default to None or "unknown"
            call_status = p.attributes.get("sip.callStatus") if p.attributes else None
            
            # Check if participant is muted based on their tracks
            is_muted = False
            for track in p.tracks:
                if track.muted:
                    is_muted = True
                    break
            
            out.append({
                "identity": p.identity,
                "name": p.name,
                # Use the state from the participant object if available, otherwise derive
                # But for SIP, we primarily rely on call_status from attributes
                "state": str(p.state) if hasattr(p, "state") else None,
                "kind": str(p.kind) if hasattr(p, "kind") else None, # Check if it's a SIP participant
                "call_status": call_status, # <-- THIS IS THE NEW FIELD
                "phone_number": p.attributes.get("sip.phoneNumber") if p.attributes else None,
                "muted": is_muted,
            })
        return {"ok": True, "participants": out}
    finally:
        await lkapi.aclose()

# -----------------------------
# END CALL (delete room)
# -----------------------------
class EndRequest(BaseModel):
    room: str


@app.post("/end")
async def end_call(req: EndRequest):
    lkapi = api.LiveKitAPI(
        LIVEKIT_URL,
        LIVEKIT_API_KEY,
        LIVEKIT_API_SECRET,
    )

    try:
        from livekit.api.twirp_client import TwirpError
        try:
            await lkapi.room.delete_room(
                api.DeleteRoomRequest(room=req.room)
            )
            return {"ok": True}
        except TwirpError as e:
            if e.code == "not_found":
                # Room was already cleaned up by LiveKit Cloud
                return {"ok": True, "message": "Room already closed"}
            raise e

    finally:
        await lkapi.aclose()

# -----------------------------
# PARTICIPANT MANAGEMENT
# -----------------------------
class ParticipantActionRequest(BaseModel):
    room: str
    identity: str

@app.post("/participant/remove")
async def remove_participant(req: ParticipantActionRequest):
    lkapi = api.LiveKitAPI(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    try:
        await lkapi.room.remove_participant(api.RoomParticipantIdentity(
            room=req.room,
            identity=req.identity,
        ))
        return {"ok": True}
    finally:
        await lkapi.aclose()

class MuteParticipantRequest(BaseModel):
    room: str
    identity: str
    muted: bool

@app.post("/participant/mute")
async def mute_participant(req: MuteParticipantRequest):
    lkapi = api.LiveKitAPI(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    try:
        p = await lkapi.room.get_participant(api.RoomParticipantIdentity(
            room=req.room,
            identity=req.identity,
        ))
        
        track_sid = p.tracks[0].sid if p.tracks else None
        
        if track_sid:
            await lkapi.room.mute_published_track(api.MuteRoomTrackRequest(
                room=req.room,
                identity=req.identity,
                track_sid=track_sid,
                muted=req.muted,
            ))
            return {"ok": True}
        return {"ok": False, "error": "No tracks found to mute"}
    finally:
        await lkapi.aclose()
