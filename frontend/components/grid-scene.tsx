'use client'

import { Canvas, useFrame } from '@react-three/fiber'
import { Grid } from '@react-three/drei'
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

// Each box wanders the grid independently — a loose visual echo of payments
// hopping to fresh one-time addresses rather than sitting at a fixed one.
function AnimatedBox({ initialPosition }: { initialPosition: [number, number, number] }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const [targetPosition, setTargetPosition] = useState(new THREE.Vector3(...initialPosition))
  const currentPosition = useRef(new THREE.Vector3(...initialPosition))

  const getAdjacentIntersection = (current: THREE.Vector3) => {
    const directions = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]
    const randomDirection = directions[Math.floor(Math.random() * directions.length)]
    return new THREE.Vector3(
      current.x + randomDirection[0] * 3,
      0.5,
      current.z + randomDirection[1] * 3,
    )
  }

  useEffect(() => {
    const interval = setInterval(() => {
      const newPosition = getAdjacentIntersection(currentPosition.current)
      newPosition.x = Math.max(-15, Math.min(15, newPosition.x))
      newPosition.z = Math.max(-15, Math.min(15, newPosition.z))
      setTargetPosition(newPosition)
    }, 1000)

    return () => clearInterval(interval)
  }, [])

  useFrame(() => {
    if (meshRef.current) {
      currentPosition.current.lerp(targetPosition, 0.1)
      meshRef.current.position.copy(currentPosition.current)
    }
  })

  return (
    <mesh ref={meshRef} position={initialPosition}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#ff6b1a" opacity={0.9} transparent />
      <lineSegments>
        <edgesGeometry attach="geometry" args={[new THREE.BoxGeometry(1, 1, 1)]} />
        <lineBasicMaterial attach="material" color="#000000" linewidth={2} />
      </lineSegments>
    </mesh>
  )
}

const ALL_POSITIONS: [number, number, number][] = [
  [-9, 0.5, -9],
  [-3, 0.5, -3],
  [0, 0.5, 0],
  [3, 0.5, 3],
  [9, 0.5, 9],
  [-6, 0.5, 6],
  [6, 0.5, -6],
  [-12, 0.5, 0],
  [12, 0.5, 0],
  [0, 0.5, 12],
]

function Scene({ boxes }: { boxes: number }) {
  return (
    <>
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} />
      <Grid
        renderOrder={-1}
        position={[0, 0, 0]}
        infiniteGrid
        cellSize={1}
        cellThickness={0.5}
        sectionSize={3}
        sectionThickness={1}
        sectionColor={[0.5, 0.5, 0.5]}
        fadeDistance={50}
      />
      {ALL_POSITIONS.slice(0, boxes).map((position, index) => (
        <AnimatedBox key={index} initialPosition={position} />
      ))}
    </>
  )
}

/**
 * Fixed full-bleed background. App pages pass a heavier `overlay` and fewer
 * boxes so the scene reads as texture behind the forms rather than competing
 * with them.
 */
export default function GridScene({
  boxes = 10,
  overlay = 'from-black/70 via-black/50 to-black',
}: {
  boxes?: number
  overlay?: string
}) {
  return (
    <>
      <Canvas shadows camera={{ position: [30, 30, 30], fov: 50 }} className="!fixed inset-0">
        <Scene boxes={boxes} />
      </Canvas>
      <div className={`pointer-events-none fixed inset-0 bg-gradient-to-b ${overlay}`} />
    </>
  )
}
