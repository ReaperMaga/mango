# Build: docker build -t planner-server .
# Run:   docker run -d --name planner -p 8080:8080 -v planner-data:/data planner-server
# Admin: docker exec planner /planner-server space add team --name "Team"

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=0.1.0
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/planner-server . \
 && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/planner-server /planner-server
COPY --from=build --chown=nonroot:nonroot /out/data /data
ENV PLANNER_ADDR=:8080 \
    PLANNER_DB=/data/planner.db
VOLUME /data
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/planner-server"]
CMD ["serve"]
