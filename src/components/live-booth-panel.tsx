import { useEffect, useRef, useState, type FormEvent } from "react"
import frameCutout from "@/assets/frame-cutout.png"
import { Camera3D, Download3D } from "@/components/icons-3d"
import { isSupabaseConfigured, supabase } from "@/lib/supabase"
import { IDENTITY_TRANSFORM } from "@/lib/photo-transform"
import { Copy, Maximize2, Minimize2, Monitor, SwitchCamera } from "lucide-react"
import { composeFrame } from "@/lib/compose-frame"

type BoothRole = "camera" | "display" | null
type Signal = { type: string; [key: string]: unknown }
type LiveBoothPanelProps = {
  onExported?: (blob: Blob, name: string) => void
}

const PAIRING_CODE_LENGTH = 6
const channelName = (code: string) => `pitech-photo-booth:pair:${code}`

function createPairingCode() {
  const value = new Uint32Array(1)
  crypto.getRandomValues(value)
  return String(100000 + (value[0] % 900000))
}

function captureVideoFrame(
  video: HTMLVideoElement | null,
  send: (dataUrl: string) => void,
) {
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false
  const maxWidth = 1280
  const scale = Math.min(1, maxWidth / video.videoWidth)
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  const context = canvas.getContext("2d")
  if (!context) return false
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  send(canvas.toDataURL("image/jpeg", 0.82))
  return true
}

async function requestCamera(mode: "user" | "environment") {
  const constraints: MediaStreamConstraints = {
    video: { facingMode: { exact: mode } },
    audio: false,
  }

  try {
    return await navigator.mediaDevices.getUserMedia(constraints)
  } catch (error) {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const cameras = devices.filter((device) => device.kind === "videoinput")
    const preferred = cameras.find((device) => {
      const label = device.label.toLowerCase()
      const isBack = /back|rear|environment|world/.test(label)
      return mode === "environment" ? isBack : !isBack
    })

    if (!preferred) throw error
    return navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: preferred.deviceId } },
      audio: false,
    })
  }
}

export function LiveBoothPanel({ onExported }: LiveBoothPanelProps) {
  const [role, setRole] = useState<BoothRole>(null)
  const [status, setStatus] = useState("Choose a device role to begin.")
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user")
  const [pairingCode, setPairingCode] = useState("")
  const [codeInput, setCodeInput] = useState("")
  const [isFullscreen, setIsFullscreen] = useState(false)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const displayStageRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<ReturnType<NonNullable<typeof supabase>["channel"]> | null>(null)

  useEffect(() => {
    const syncFullscreen = () => {
      setIsFullscreen(document.fullscreenElement === displayStageRef.current)
    }
    document.addEventListener("fullscreenchange", syncFullscreen)
    return () => document.removeEventListener("fullscreenchange", syncFullscreen)
  }, [])

  const startCamera = async (mode: "user" | "environment") => {
    const previousStream = streamRef.current
    previousStream?.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    const stream = await requestCamera(mode)
    const nextTrack = stream.getVideoTracks()[0]
    const sender = peerRef.current
      ?.getSenders()
      .find((item) => item.track?.kind === "video")

    if (sender && nextTrack) {
      await sender.replaceTrack(nextTrack)
    }
    streamRef.current = stream
    if (localVideoRef.current) localVideoRef.current.srcObject = stream
    setFacingMode(mode)
    setStatus(
      mode === "user"
        ? "Front camera active. Enter the code below on your display."
        : "Back camera active. Enter the code below on your display.",
    )
  }

  useEffect(() => {
    if (!role || !pairingCode || !supabase || !isSupabaseConfigured) return

    let active = true
    const localVideo = localVideoRef.current
    const remoteVideo = remoteVideoRef.current
    const client = supabase
    const channel = client.channel(channelName(pairingCode), {
      config: { broadcast: { self: false } },
    })
    channelRef.current = channel
    let offerStarted = false
    const pendingCandidates: RTCIceCandidateInit[] = []

    const send = (payload: Signal) => {
      void channel.send({ type: "broadcast", event: "signal", payload })
    }

    const createPeer = () => {
      peerRef.current?.close()
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      })
      peerRef.current = peer
      peer.onicecandidate = (event) => {
        if (event.candidate) send({ type: "candidate", candidate: event.candidate })
      }
      peer.ontrack = (event) => {
        if (remoteVideo) {
          remoteVideo.srcObject = event.streams[0]
        }
        setStatus("Live camera connected. You can capture from either device.")
      }
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected" && role === "camera") {
          setStatus("Live display connected.")
        } else if (peer.connectionState === "failed") {
          setStatus("Could not connect. Check both devices are online and try again.")
        } else if (peer.connectionState === "disconnected") {
          setStatus("Display connection lost. Re-enter the code to reconnect.")
        }
      }
      return peer
    }

    const handleSignal = async ({ payload }: { payload: Signal }) => {
      if (!active) return

      if (role === "camera" && payload.type === "display-ready" && !offerStarted) {
        const peer = createPeer()
        const stream = streamRef.current
        if (!stream) return
        offerStarted = true
        stream.getTracks().forEach((track) => peer.addTrack(track, stream))
        const offer = await peer.createOffer()
        await peer.setLocalDescription(offer)
        send({ type: "offer", description: offer })
        setStatus("Connecting to the display…")
      }

      if (role === "camera" && payload.type === "capture-request") {
        const captured = captureVideoFrame(localVideo, (dataUrl) =>
          send({ type: "photo", dataUrl }),
        )
        if (captured) setStatus("Photo captured and sent to the display.")
      }

      if (role === "display" && payload.type === "camera-ready") {
        send({ type: "display-ready" })
      }

      if (role === "camera" && payload.type === "answer" && peerRef.current) {
        await peerRef.current.setRemoteDescription(
          payload.description as RTCSessionDescriptionInit,
        )
        await Promise.all(
          pendingCandidates.splice(0).map((candidate) =>
            peerRef.current?.addIceCandidate(candidate),
          ),
        )
      }

      if (role === "display" && payload.type === "offer") {
        const peer = createPeer()
        await peer.setRemoteDescription(
          payload.description as RTCSessionDescriptionInit,
        )
        await Promise.all(
          pendingCandidates.splice(0).map((candidate) => peer.addIceCandidate(candidate)),
        )
        const answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        send({ type: "answer", description: answer })
        setStatus("Connecting to the mobile camera…")
      }

      if (payload.type === "candidate") {
        const candidate = payload.candidate as RTCIceCandidateInit
        if (peerRef.current?.remoteDescription) {
          await peerRef.current.addIceCandidate(candidate)
        } else {
          pendingCandidates.push(candidate)
        }
      }

      if (role === "display" && payload.type === "photo") {
        const dataUrl = String(payload.dataUrl)
        setStatus("Framing your photo…")
        try {
          const blob = await composeFrame(dataUrl, IDENTITY_TRANSFORM)
          onExported?.(blob, `pitech-photobooth-${Date.now()}.png`)
          setStatus("Photo saved. Opening your images…")
        } catch {
          setStatus("The photo was captured, but framing failed. Please try again.")
        }
      }
    }

    channel.on("broadcast", { event: "signal" }, handleSignal)
    void channel.subscribe(async (subscriptionStatus) => {
      if (subscriptionStatus !== "SUBSCRIBED") {
        if (active && ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(subscriptionStatus)) {
          setStatus("Could not connect to the pairing service. Check your internet connection and try again.")
        }
        return
      }
      if (role === "camera") {
        try {
          const stream = await requestCamera("user")
          if (!active) {
            stream.getTracks().forEach((track) => track.stop())
            return
          }
          streamRef.current = stream
          if (localVideo) localVideo.srcObject = stream
          setStatus("Camera ready. Enter this code on the display to connect.")
          send({ type: "camera-ready" })
        } catch {
          setStatus("Could not start the camera. Check camera permission and try again.")
        }
      } else {
        send({ type: "display-ready" })
        setStatus("Waiting for the mobile camera to connect…")
      }
    })

    return () => {
      active = false
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      peerRef.current?.close()
      peerRef.current = null
      if (localVideo) localVideo.srcObject = null
      if (remoteVideo) remoteVideo.srcObject = null
      void client.removeChannel(channel)
      channelRef.current = null
    }
  }, [onExported, pairingCode, role])

  const connectDisplay = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const code = codeInput.replace(/\D/g, "").slice(0, PAIRING_CODE_LENGTH)
    if (code.length !== PAIRING_CODE_LENGTH) return
    setPairingCode(code)
  }

  const leaveRole = () => {
    setPairingCode("")
    setRole(null)
    setStatus("Choose a device role to begin.")
  }

  const copyPairingCode = async () => {
    try {
      await navigator.clipboard.writeText(pairingCode)
      setStatus("Pairing code copied. Enter it on the display.")
    } catch {
      setStatus("Could not copy the code. Enter it manually on the display.")
    }
  }

  const toggleFullscreen = async () => {
    const stage = displayStageRef.current
    if (!stage) return
    try {
      if (document.fullscreenElement === stage) {
        await document.exitFullscreen()
      } else {
        await stage.requestFullscreen()
      }
    } catch {
      setStatus("Fullscreen is unavailable in this browser.")
    }
  }

  const switchCamera = async () => {
    if (role !== "camera") return
    try {
      await startCamera(facingMode === "user" ? "environment" : "user")
    } catch {
      setStatus("The other camera is not available on this device.")
    }
  }

  const capturePhoto = () => {
    const channel = channelRef.current
    if (!channel) return
    const captured = captureVideoFrame(localVideoRef.current, (dataUrl) => {
      void channel.send({
        type: "broadcast",
        event: "signal",
        payload: { type: "photo", dataUrl },
      })
    })
    if (captured) setStatus("Photo captured and sent to the display.")
  }

  if (!isSupabaseConfigured) {
    return (
      <section className="neumorphic-card mx-auto flex w-full max-w-2xl flex-col gap-3 rounded-3xl p-8 text-center">
        <h2 className="text-2xl font-bold text-foreground">Live Photo Booth</h2>
        <p className="text-sm font-medium text-muted-foreground">
          Configure Supabase to connect the mobile camera to another display.
        </p>
      </section>
    )
  }

  if (!role) {
    return (
      <section className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6 text-center">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-foreground">
            Live Photo Booth
          </h2>
          <p className="mt-2 text-sm font-medium text-muted-foreground">
            Connect a mobile camera to any nearby screen with a one-time code.
          </p>
        </div>
        <div className="grid w-full gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              setPairingCode(createPairingCode())
              setRole("camera")
            }}
            className="neumorphic-button flex min-h-32 flex-col items-center justify-center gap-3 rounded-3xl px-6 text-white"
          >
            <Camera3D size={30} />
            <span className="font-semibold">Mobile Camera</span>
          </button>
          <button
            type="button"
            onClick={() => setRole("display")}
            className="neumorphic-button flex min-h-32 flex-col items-center justify-center gap-3 rounded-3xl px-6 text-white"
          >
            <Download3D size={30} />
            <span className="font-semibold">Live Display</span>
          </button>
        </div>
      </section>
    )
  }

  if (role === "display" && !pairingCode) {
    return (
      <section className="neumorphic-card mx-auto flex w-full max-w-md flex-col items-center gap-5 rounded-3xl p-6 text-center sm:p-8">
        <span className="icon-3d flex h-14 w-14 items-center justify-center rounded-2xl text-white">
          <Monitor size={28} />
        </span>
        <div>
          <h2 className="text-2xl font-bold text-foreground">Connect a camera</h2>
          <p className="mt-2 text-sm font-medium text-muted-foreground">
            Enter the six-digit code shown on the mobile camera.
          </p>
        </div>
        <form onSubmit={connectDisplay} className="flex w-full flex-col gap-3">
          <label htmlFor="booth-pairing-code" className="sr-only">
            Six-digit pairing code
          </label>
          <input
            id="booth-pairing-code"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={PAIRING_CODE_LENGTH}
            value={codeInput}
            onChange={(event) =>
              setCodeInput(event.target.value.replace(/\D/g, "").slice(0, PAIRING_CODE_LENGTH))
            }
            placeholder="000000"
            className="w-full rounded-2xl border border-[#d3e8da] bg-white px-4 py-4 text-center font-mono text-3xl font-bold tracking-[0.35em] text-foreground outline-none focus:ring-2 focus:ring-[#16794a]"
            required
          />
          <button
            type="submit"
            disabled={codeInput.length !== PAIRING_CODE_LENGTH}
            className="neumorphic-button flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Connect to camera
          </button>
        </form>
        <button type="button" onClick={leaveRole} className="text-sm font-semibold text-[#16794a]">
          Change device role
        </button>
      </section>
    )
  }

  if (role === "camera") {
    return (
      <section className="booth-camera-layout mx-auto flex w-full max-w-xl flex-col items-center gap-5 text-center">
        <div className="booth-camera-preview relative w-full overflow-hidden rounded-3xl bg-[#062b16] shadow-brand-lg">
          <video ref={localVideoRef} autoPlay muted playsInline className="aspect-square w-full object-cover" />
          <img
            src={frameCutout}
            alt="Photo booth frame guide"
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
        </div>
        <div className="booth-camera-controls flex w-full flex-col items-center gap-5">
          <p className="text-xs font-medium text-muted-foreground">
            Align your subject inside the frame guide before capturing.
          </p>
          <h2 className="text-2xl font-bold text-foreground">Mobile Camera</h2>
          <p role="status" className="text-sm font-medium text-muted-foreground">{status}</p>
          <div className="neumorphic-card flex w-full max-w-xs flex-col items-center gap-2 rounded-2xl p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Display connection code
            </p>
            <div className="flex w-full items-center justify-center gap-3">
              <span className="font-mono text-3xl font-bold tracking-[0.3em] text-foreground">
                {pairingCode}
              </span>
              <button
                type="button"
                onClick={() => void copyPairingCode()}
                aria-label="Copy pairing code"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[#16794a] hover:bg-[#eaf5ee]"
              >
                <Copy size={18} />
              </button>
            </div>
            <p className="text-xs text-muted-foreground">Enter this code on the display device.</p>
          </div>
          <div className="flex w-full max-w-xs flex-col gap-3">
          <button
            type="button"
            onClick={capturePhoto}
            className="neumorphic-button flex h-14 w-full items-center justify-center gap-3 rounded-2xl text-white"
          >
            <Camera3D size={23} />
            <span className="font-semibold">Capture Photo</span>
          </button>
          <button
            type="button"
            onClick={switchCamera}
            className="neumorphic-button flex h-12 w-full items-center justify-center gap-3 rounded-2xl text-white"
          >
            <SwitchCamera size={20} />
            <span className="font-semibold">Switch to {facingMode === "user" ? "Back" : "Front"} Camera</span>
          </button>
          </div>
          <button type="button" onClick={leaveRole} className="text-sm font-semibold text-[#16794a]">
            Change device role
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="flex w-full flex-col items-center gap-8">
      <div className="flex w-full max-w-6xl flex-col items-center gap-6 lg:flex-row lg:items-start lg:justify-center lg:gap-12">
        <div ref={displayStageRef} className="booth-display-stage relative w-full max-w-[min(90vw,560px)] shrink-0 overflow-hidden rounded-3xl bg-[#062b16] shadow-brand-lg">
          <video ref={remoteVideoRef} autoPlay playsInline className="aspect-square w-full object-cover" />
          <img
            src={frameCutout}
            alt="Photo booth frame guide"
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            aria-label={isFullscreen ? "Exit fullscreen display" : "Show fullscreen display"}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-xl bg-white/90 text-[#0b3a20] shadow-md"
          >
            {isFullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
          </button>
        </div>
        <div className="flex w-full max-w-md flex-col items-center gap-5 pt-2 text-center lg:pt-8">
          <h2 className="text-2xl font-bold text-foreground">Live Display</h2>
          <p role="status" className="text-sm font-medium text-muted-foreground">{status}</p>
          <div className="neumorphic-card w-full rounded-3xl p-6">
            <p className="text-sm font-medium text-muted-foreground">
              The live camera feed appears here. Capture on the mobile camera,
              or use this display to take a framed photo.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              const channel = channelRef.current
              if (!channel) return
              void channel.send({
                type: "broadcast",
                event: "signal",
                payload: { type: "capture-request" },
              })
            }}
            className="neumorphic-button flex h-14 w-full max-w-xs items-center justify-center gap-3 rounded-2xl text-white"
          >
            <Camera3D size={22} />
            <span className="font-semibold">Take Photo</span>
          </button>
          <button type="button" onClick={leaveRole} className="text-sm font-semibold text-[#16794a]">
            Change device role
          </button>
        </div>
      </div>
    </section>
  )
}
