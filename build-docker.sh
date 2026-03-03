#!/bin/bash
set -e

# Define image name
IMAGE_NAME="ipowerink/oriontv-android-builder:o1"

# Build the Docker image
# We explicitly target linux/amd64 to ensure compatibility with prebuilt binaries (like Hermes)
# echo "Building Docker image..."
# docker build --platform linux/amd64 -t $IMAGE_NAME .

# Create artifacts directory if it doesn't exist
mkdir -p artifacts

# Run the build container
echo "Running build in Docker..."
docker run --platform linux/amd64 --rm \
    -v "$(pwd):/app" \
    -v "$(pwd)/artifacts:/app/artifacts" \
    $IMAGE_NAME \
    bash -c "
        set -e
        echo 'Starting build process inside Docker...'
        
        # Install dependencies
        yarn install --frozen-lockfile
        
        # Prebuild (Expo)
        # Set EXPO_TV and other env vars as per package.json
        export EXPO_TV=1
        export EXPO_USE_METRO_WORKSPACE_ROOT=1
        export NODE_ENV=production
        
        echo 'Running prebuild...'
        yarn prebuild
        
        # Build Android APK
        echo 'Building Release APK...'
        cd android
        ./gradlew assembleRelease --stacktrace
        
        # Copy artifact
        echo 'Copying artifact...'
        mkdir -p ../artifacts
        cp app/build/outputs/apk/release/app-release.apk ../artifacts/orionTV-release.apk
        
        echo 'Build complete! APK is in artifacts/orionTV-release.apk'
    "
