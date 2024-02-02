import { useState, useEffect } from "react";
import {
  getReleaseBySlug,
  getCode,
  removeCode,
  addCodeToFan,
  getFanDocument,
} from "../firebase";
import { useParams, useNavigate } from "react-router-dom";

type AlbumPageProps = {
  fanProfile: any;
  setFanProfile: any;
};

const AlbumPage: React.FC<AlbumPageProps> = ({ fanProfile, setFanProfile }) => {
  const [release, setRelease] = useState<any>(null);
  const [alreadyRedeemed, setAlreadyRedeemed] = useState<boolean>(false);
  const { releaseSlug } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    const getReleaseData = async () => {
      const releaseData = await getReleaseBySlug(releaseSlug || "");
      setRelease(releaseData);
    };
    getReleaseData();
  }, [releaseSlug]);

  const convertDate = (date: string) => {
    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "long",
      day: "numeric",
    };
    return new Date(date).toLocaleDateString("en-US", options);
  };

  const handleGetCode = async () => {
    if (!fanProfile) return;
    if (releaseSlug === undefined) return;
    const code = await getCode(releaseSlug || "");
    if (code) {
      await removeCode(releaseSlug || "", code);
      setRelease({
        ...release,
        codes: release.codes.filter((c: string) => c !== code),
      });
      await addCodeToFan(fanProfile.uid, releaseSlug, code);
      const fanData = await getFanDocument(fanProfile.uid);
      setFanProfile(fanData);
    }
  };

  useEffect(() => {
    if (releaseSlug === undefined) {
      navigate("/");
    }
  }, [releaseSlug]);

  useEffect(() => {
    if (!fanProfile) return;
    if (fanProfile.redeemed.length > 0) {
      for (const release of fanProfile.redeemed) {
        if (release.releaseSlug === releaseSlug) {
          setAlreadyRedeemed(true);
          break;
        }
      }
    }
  }, [fanProfile, releaseSlug]);

  return (
    <div className="flex flex-col items-center min-h-[95vh] w-full">
      <h1 className="text-6xl m-5 mx-auto font-bold mt-[100px]">
        {release?.name}
      </h1>
      <div className="flex flex-row gap-10 mx-auto justify-center">
        <img
          src={release?.image}
          alt={release?.name}
          className="w-[300px] h-[300px] object-cover rounded-xl"
        />
      </div>
      <p className="text-3xl m-7 my-1 mx-auto">
        {release?.releaseType} by {release?.artist}
      </p>
      <p className="text-3xl m-7 my-1 mx-auto italic">
        Released: {convertDate(release?.releaseDate)}
      </p>
      <p className="text-2xl m-7 my-1 mx-auto w-[50%] text-center">
        {release?.about}
      </p>
      <p className="text-5xl my-2 mx-auto">
        Codes Available: {release?.codes.length}
      </p>
      <div className="flex flex-row gap-10 mx-auto justify-center my-5">
        <div
          className={
            fanProfile
              ? alreadyRedeemed || release?.codes.length === 0
                ? "btn btn-primary btn-lg text-3xl btn-disabled"
                : "btn btn-primary btn-lg text-3xl"
              : "btn btn-primary btn-lg text-3xl btn-disabled"
          }
          onClick={handleGetCode}
        >
          {fanProfile
            ? alreadyRedeemed
              ? "Already Redeemed!"
              : "Get Code!"
            : "Login to a fan account to redeem code!"}
        </div>
        <a
          className="btn btn-secondary btn-lg text-3xl"
          href={release?.link}
          target="_blank"
        >
          Bandcamp
        </a>
      </div>
    </div>
  );
};

export default AlbumPage;
