import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'eu-central-1',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true, // required for MinIO
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
});

const BUCKET = process.env.S3_BUCKET!;

export async function uploadFile(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

export async function downloadFile(key: string): Promise<Buffer> {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const stream = response.Body;
  if (!stream) throw new Error('Empty S3 response');
  // @ts-ignore - SDK stream
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function getSignedUrl(key: string, expiresIn: number): Promise<string> {
  return awsGetSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}
